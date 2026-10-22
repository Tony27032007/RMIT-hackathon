using Ork.Forseti.Sdk;
using Cryptide.Tools;
using Ork.Shared.Models.Contracts;
using System;
using System.Collections.Generic;
using System.Text;

public class Contract : IAccessPolicy
{
    private const string PolicySignRequest = "Policy:1";
    private const string EncryptRequest = "PolicyEnabledEncryption:1";
    private const string DecryptRequest = "PolicyEnabledDecryption:1";
    private const string GuardianActionModel = "BasicCustom<HomeLockGuardianAction>:BasicCustom<1>";
    private const string EncryptRole = "_tide_encryptor";
    private const string DecryptRole = "_tide_decryptor";
    private const int MaxGuardians = 128;
    private const int MaxFieldLength = 256;

    [PolicyParam(Required = true, Description = "HomeLock OIDC client id")]
    public string Resource { get; set; }

    [PolicyParam(Required = true, Description = "Client role assigned to current repository guardians")]
    public string GuardianRole { get; set; }

    [PolicyParam(Required = true, Description = "Repository UUID bound to this policy")]
    public string RepositoryId { get; set; }

    [PolicyParam(Required = true, Description = "Current guardian Vuids, comma-separated without duplicates")]
    public string GuardianVuids { get; set; }

    [PolicyParam(Required = true, Description = "Monotonically increasing repository membership version")]
    public string MembershipVersion { get; set; }

    [PolicyParam(Required = false, Default = "", Description = "Vuid of the guardian requesting one video view")]
    public string RequesterVuid { get; set; } = "";

    [PolicyParam(Required = false, Default = "", Description = "Unique tag for one repository file")]
    public string RecordTag { get; set; } = "";

    private string _requestId;
    private string _issuer;
    private List<string> _guardianVuids;

    public PolicyDecision ValidateData(DataContext ctx)
    {
        _requestId = null;
        _issuer = null;
        _guardianVuids = null;

        if (ctx.Policy.ExecutionType != ExecutionType.PRIVATE)
            return PolicyDecision.Deny("HomeLock guardian policies must use PRIVATE execution");

        _guardianVuids = new List<string>();
        if (!TryReadGuardianVuids(_guardianVuids))
            return PolicyDecision.Deny("the signed policy has an invalid guardian roster");
        if (!IsPositiveDecimal(MembershipVersion))
            return PolicyDecision.Deny("the signed policy has an invalid membership version");
        if (string.IsNullOrEmpty(Resource) || string.IsNullOrEmpty(GuardianRole)
            || string.IsNullOrEmpty(RepositoryId))
            return PolicyDecision.Deny("the signed policy is missing its repository identity");

        if (ctx.RequestId == PolicySignRequest)
        {
            if (ctx.Policy.ApprovalType != ApprovalType.EXPLICIT)
                return PolicyDecision.Deny("guardian action signing must require explicit approval");

            var decision = ValidateGuardianActionPolicy(ctx);
            if (decision != null) return decision;
            _requestId = PolicySignRequest;
            return PolicyDecision.Allow();
        }

        if (ctx.RequestId == EncryptRequest || ctx.RequestId == DecryptRequest)
        {
            var requiredApproval = ctx.RequestId == DecryptRequest
                ? ApprovalType.EXPLICIT
                : ApprovalType.IMPLICIT;
            if (ctx.Policy.ApprovalType != requiredApproval)
                return PolicyDecision.Deny("the encryption policy has the wrong approval mode");
            if (ctx.RequestId == DecryptRequest
                && (string.IsNullOrEmpty(RequesterVuid) || !Contains(_guardianVuids, RequesterVuid)))
                return PolicyDecision.Deny("the video requester must be named as a current guardian");
            if (!HasRepositoryRecordTag(ctx))
                return PolicyDecision.Deny("the request must contain exactly this repository file tag");

            _requestId = ctx.RequestId;
            return PolicyDecision.Allow();
        }

        return PolicyDecision.Deny("this policy only supports HomeLock actions and repository files");
    }

    public PolicyDecision ValidateApprovers(ApproversContext ctx)
    {
        if (_requestId == EncryptRequest)
            return PolicyDecision.Allow();
        if (_requestId != PolicySignRequest && _requestId != DecryptRequest)
            return PolicyDecision.Deny("guardian approval was requested without validated data");
        if (_guardianVuids == null || _guardianVuids.Count == 0)
            return PolicyDecision.Deny("the current guardian roster is unavailable");

        var approvers = DokenDto.WrapAll(ctx.Dokens);
        var expectedApprovals = _guardianVuids.Count;
        if (_requestId == DecryptRequest) expectedApprovals--;
        if (approvers.Count != expectedApprovals)
            return PolicyDecision.Deny("every required guardian must approve exactly once");

        var approvedVuids = new List<string>();
        foreach (var approver in approvers)
        {
            var vuid = approver.UserId;
            if (approver.IsNull || approver.IsExpired || string.IsNullOrEmpty(vuid))
                return PolicyDecision.Deny("a guardian approval is missing, expired, or invalid");
            if (!Contains(_guardianVuids, vuid) || Contains(approvedVuids, vuid))
                return PolicyDecision.Deny("approvals must match the current guardian roster exactly");
            if (_requestId == DecryptRequest && vuid == RequesterVuid)
                return PolicyDecision.Deny("the video requester is not an approver of their own request");
            if (!approver.HasRole(Resource, GuardianRole))
                return PolicyDecision.Deny("every approver must hold the repository guardian role");
            approvedVuids.Add(vuid);
        }

        foreach (var guardian in _guardianVuids)
        {
            if (_requestId == DecryptRequest && guardian == RequesterVuid) continue;
            if (!Contains(approvedVuids, guardian))
                return PolicyDecision.Deny("an approval from every required current guardian is required");
        }
        return PolicyDecision.Allow();
    }

    public PolicyDecision ValidateExecutor(ExecutorContext ctx)
    {
        if (_requestId == null || _guardianVuids == null)
            return PolicyDecision.Deny("the request has no validated HomeLock policy");

        var executor = new DokenDto(ctx.Doken);
        if (executor.IsNull || executor.IsExpired || string.IsNullOrEmpty(executor.UserId))
            return PolicyDecision.Deny("the executor credential is missing, expired, or invalid");
        if (!Contains(_guardianVuids, executor.UserId)
            || !executor.HasRole(Resource, GuardianRole))
            return PolicyDecision.Deny("only a current repository guardian may execute this request");

        if (_requestId == PolicySignRequest && executor.UserId != _issuer)
            return PolicyDecision.Deny("the action issuer must match the authenticated executor");
        if (_requestId == DecryptRequest && executor.UserId != RequesterVuid)
            return PolicyDecision.Deny("the video requester must match the authenticated executor");
        if (_requestId == EncryptRequest && !executor.HasRole(EncryptRole))
            return PolicyDecision.Deny("the executor lacks the Tide encryption role");
        if (_requestId == DecryptRequest && !executor.HasRole(DecryptRole))
            return PolicyDecision.Deny("the executor lacks the Tide decryption role");
        return PolicyDecision.Allow();
    }

    private PolicyDecision ValidateGuardianActionPolicy(DataContext ctx)
    {
        string claim = null;
        string issuer = null;
        string objectId = null;
        string resource = null;
        string subject = null;
        string value = null;
        string requestId = null;

        try
        {
            ReadOnlyMemory<byte> data = ctx.Data;
            var body = data.GetValue(0).GetValue(0);
            var models = body.GetValue(2);
            if (!models.TryGetValue(0, out var model)
                || Encoding.UTF8.GetString(model.Span) != GuardianActionModel
                || models.TryGetValue(1, out _))
                return PolicyDecision.Deny("the signed action must use the HomeLock guardian-action model");

            if (Encoding.UTF8.GetString(body.GetValue(4).Span) != "IMPLICIT"
                || Encoding.UTF8.GetString(body.GetValue(5).Span) != "PRIVATE"
                || body.TryGetValue(7, out _))
                return PolicyDecision.Deny("the guardian action statement must be IMPLICIT, PRIVATE, and have no expiry");

            var parameters = body.GetValue(6);
            for (int i = 0; parameters.TryGetValue(i, out var entry); i++)
            {
                var name = Encoding.UTF8.GetString(entry.GetValue(0).Span);
                var type = Encoding.UTF8.GetString(entry.GetValue(1).Span);
                var text = Encoding.UTF8.GetString(entry.GetValue(2).Span);
                if (type != "str" || text.Length == 0 || text.Length > MaxFieldLength)
                    return PolicyDecision.Deny("guardian action fields must be bounded, non-empty strings");

                if (name == "Claim")
                {
                    if (claim != null) return PolicyDecision.Deny("the action repeats Claim");
                    claim = text;
                }
                else if (name == "Issuer")
                {
                    if (issuer != null) return PolicyDecision.Deny("the action repeats Issuer");
                    issuer = text;
                }
                else if (name == "Object")
                {
                    if (objectId != null) return PolicyDecision.Deny("the action repeats Object");
                    objectId = text;
                }
                else if (name == "Resource")
                {
                    if (resource != null) return PolicyDecision.Deny("the action repeats Resource");
                    resource = text;
                }
                else if (name == "Subject")
                {
                    if (subject != null) return PolicyDecision.Deny("the action repeats Subject");
                    subject = text;
                }
                else if (name == "Value")
                {
                    if (value != null) return PolicyDecision.Deny("the action repeats Value");
                    value = text;
                }
                else if (name == "RequestId")
                {
                    if (requestId != null) return PolicyDecision.Deny("the action repeats RequestId");
                    requestId = text;
                }
                else
                {
                    return PolicyDecision.Deny("the action contains an unsupported field");
                }
            }
        }
        catch
        {
            return PolicyDecision.Deny("the HomeLock guardian action could not be decoded");
        }

        if (claim == null || issuer == null || objectId == null
            || resource == null || subject == null || value == null || requestId == null)
            return PolicyDecision.Deny("the action must name Claim, Issuer, Object, Resource, Subject, Value, and RequestId");
        if (claim != "guardian-invite" && claim != "file-delete")
            return PolicyDecision.Deny("this policy only signs guardian invitations and file deletions");
        if (objectId != RepositoryId || resource != Resource)
            return PolicyDecision.Deny("the action does not match this repository and client");
        if (!Contains(_guardianVuids, issuer))
            return PolicyDecision.Deny("the action issuer is not a current guardian");
        if (!HasCurrentMembershipVersion(value, requestId))
            return PolicyDecision.Deny("the action was created for a different membership version");
        if (claim == "guardian-invite" && subject == issuer)
            return PolicyDecision.Deny("a guardian cannot invite themselves");

        _issuer = issuer;
        return null;
    }

    private bool HasRepositoryRecordTag(DataContext ctx)
    {
        if (string.IsNullOrEmpty(RecordTag) || RecordTag.Length > MaxFieldLength)
            return false;

        var prefix = "homelock:" + RepositoryId + ":";
        if (RecordTag.Length <= prefix.Length
            || string.CompareOrdinal(RecordTag, 0, prefix, 0, prefix.Length) != 0)
            return false;

        try
        {
            ReadOnlyMemory<byte> data = ctx.Data;
            ReadOnlyMemory<byte> firstRequest;
            if (ctx.RequestId == EncryptRequest)
            {
                firstRequest = data.GetValue(1);
                if (data.TryGetValue(2, out _)) return false;
            }
            else
            {
                firstRequest = data.GetValue(0);
                if (data.TryGetValue(1, out _)) return false;
            }

            var tagCount = 0;
            var firstTagIndex = ctx.RequestId == EncryptRequest ? 2 : 3;
            for (int i = firstTagIndex; firstRequest.TryGetValue(i, out var tag); i++)
            {
                tagCount++;
                if (tagCount > 1 || Encoding.UTF8.GetString(tag.Span) != RecordTag)
                    return false;
            }
            return tagCount == 1;
        }
        catch
        {
            return false;
        }
    }

    private bool TryReadGuardianVuids(List<string> vuids)
    {
        if (string.IsNullOrEmpty(GuardianVuids) || GuardianVuids.Length > MaxGuardians * MaxFieldLength)
            return false;

        int start = 0;
        while (start < GuardianVuids.Length)
        {
            int comma = GuardianVuids.IndexOf(',', start);
            int end = comma < 0 ? GuardianVuids.Length : comma;
            int length = end - start;
            if (length < 1 || length > MaxFieldLength || vuids.Count >= MaxGuardians)
                return false;

            for (int i = start; i < end; i++)
            {
                if (char.IsWhiteSpace(GuardianVuids[i])) return false;
            }

            var vuid = GuardianVuids.Substring(start, length);
            if (Contains(vuids, vuid)) return false;
            vuids.Add(vuid);
            if (comma < 0) break;
            start = comma + 1;
            if (start == GuardianVuids.Length) return false;
        }
        return vuids.Count > 0;
    }

    private bool HasCurrentMembershipVersion(string value, string requestId)
    {
        if (string.IsNullOrEmpty(MembershipVersion) || string.IsNullOrEmpty(value)
            || string.IsNullOrEmpty(requestId))
            return false;
        var expected = MembershipVersion + ":" + requestId;
        return string.Equals(value, expected, StringComparison.Ordinal);
    }

    private bool IsPositiveDecimal(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 10 || value[0] == '0')
            return false;
        for (int i = 0; i < value.Length; i++)
        {
            if (value[i] < '0' || value[i] > '9') return false;
        }
        return true;
    }

    private bool Contains(List<string> values, string candidate)
    {
        foreach (var value in values)
        {
            if (string.Equals(value, candidate, StringComparison.Ordinal))
                return true;
        }
        return false;
    }
}
