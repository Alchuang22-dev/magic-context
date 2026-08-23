"""Generated Magic Context protocol bindings. Do not edit."""
from __future__ import annotations

import json
from typing import Any, Literal, NotRequired, TypeAlias, TypedDict

PROTOCOL_VERSION = 1
PROTOCOL_IDL_SHA256 = "8ca5240204fa735aef0d37cb7b53b941ffec836e60060390fd4ac33960e1a870"

ContextDecision: TypeAlias = Literal["serve", "defer", "safe_fallback", "block"]

ContextInjectionSlot: TypeAlias = Literal["stable_prefix", "volatile_delta", "tail_nudge"]

ContextMutationKind: TypeAlias = Literal["drop", "replace", "truncate_tool", "edit_marker", "prefix_tag"]

CanonicalTextKind: TypeAlias = Literal["text", "thinking"]

CanonicalOpaqueKind: TypeAlias = Literal["image", "file", "opaque"]

MEMORY_CATEGORIES = ["PROJECT_RULES","ARCHITECTURE","CONSTRAINTS","CONFIG_VALUES","NAMING"]
MemoryCategory: TypeAlias = Literal["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"]

MemoryScope: TypeAlias = Literal["project", "ecosystem", "universe"]

MemorySourceType: TypeAlias = Literal["historian", "agent", "dreamer", "tool"]

AUXILIARY_TASK_NAMES = ["historian","dreamer","sidekick"]
AuxiliaryTaskName: TypeAlias = Literal["historian", "dreamer", "sidekick"]

HostCallbackResolutionStatus: TypeAlias = Literal["completed", "retry_scheduled", "failed"]

CONTEXT_TOOL_NAMES = ["ctx_search","ctx_memory","ctx_expand","ctx_reduce","ctx_note"]
ContextToolName: TypeAlias = Literal["ctx_search", "ctx_memory", "ctx_expand", "ctx_reduce", "ctx_note"]

SessionLifecycleAction: TypeAlias = Literal["start", "end", "clone", "reset", "delete"]

ToolEventPhase: TypeAlias = Literal["pre", "post"]

CacheDecision: TypeAlias = Literal["hit_safe", "bust_required"]

HostCallbackFailureStatus: TypeAlias = Literal["failed", "timed_out"]

class AgentCapabilities(TypedDict):
    preRequestTransform: bool
    stableMessageIds: bool
    stablePartIds: bool
    usageObservation: bool
    auxiliaryLlm: bool
    toolRegistration: bool
    toolEvents: bool
    requestBlocking: bool
    systemSuffixInjection: bool
    promptCacheFacts: bool
    blockIndexMutations: NotRequired[bool]

class CanonicalTextBlock(TypedDict):
    id: NotRequired[str]
    kind: CanonicalTextKind
    text: str

class CanonicalToolCallBlock(TypedDict):
    id: NotRequired[str]
    kind: Literal["tool_call"]
    callId: str
    name: str
    input: Any

class CanonicalToolResultBlock(TypedDict):
    id: NotRequired[str]
    kind: Literal["tool_result"]
    callId: str
    name: NotRequired[str]
    output: Any
    isError: NotRequired[bool]

class CanonicalOpaqueBlock(TypedDict):
    id: NotRequired[str]
    kind: CanonicalOpaqueKind
    value: Any

class CanonicalMessage(TypedDict):
    id: str
    ordinal: int
    role: CanonicalRole
    content: list[CanonicalBlock]
    createdAtMs: NotRequired[float]
    synthetic: NotRequired[bool]

class ContextUsageObservation(TypedDict):
    inputTokens: NotRequired[float]
    outputTokens: NotRequired[float]
    cacheReadTokens: NotRequired[float]
    cacheWriteTokens: NotRequired[float]
    reasoningTokens: NotRequired[float]
    contextLimitTokens: NotRequired[float]

class ComposeContextRequest(TypedDict):
    protocolVersion: Literal[1]
    requestId: str
    host: str
    sessionId: str
    turnId: NotRequired[str]
    projectId: NotRequired[str]
    modelKey: NotRequired[str]
    budgetTokens: float
    capabilities: AgentCapabilities
    messages: list[CanonicalMessage]
    usage: NotRequired[ContextUsageObservation]

class TurnOutcomeObservation(TypedDict):
    interrupted: bool
    failed: bool
    exitReason: NotRequired[str]

class ObservedMemoryCandidate(TypedDict):
    category: MemoryCategory
    content: str
    importance: NotRequired[float]
    scope: NotRequired[MemoryScope]
    shareable: NotRequired[bool]
    sourceType: NotRequired[MemorySourceType]
    expiresAtMs: NotRequired[float]
    metadata: NotRequired[dict[str, Any]]

class ObserveTurnRequest(TypedDict):
    protocolVersion: Literal[1]
    observationId: str
    host: str
    sessionId: str
    turnId: NotRequired[str]
    taskId: NotRequired[str]
    projectId: NotRequired[str]
    modelKey: NotRequired[str]
    observedAtMs: float
    messages: list[CanonicalMessage]
    usage: NotRequired[ContextUsageObservation]
    outcome: TurnOutcomeObservation
    memoryCandidates: NotRequired[list[ObservedMemoryCandidate]]

class TurnObservationReceipt(TypedDict):
    protocolVersion: Literal[1]
    observationId: str
    sessionId: str
    accepted: bool
    revision: int
    observedAtMs: float
    callbacks: NotRequired[list[HostCallbackRequest]]

class AuxiliaryRuntimePolicy(TypedDict):
    historianEnabled: bool
    historianThresholdPercentage: float
    historianMinMessages: int
    historianProtectedTailMessages: int
    historianTimeoutMs: float
    dreamerEnabled: bool
    dreamerIntervalMs: float
    dreamerTimeoutMs: float
    sidekickEnabled: bool
    sidekickTimeoutMs: float
    maxAttempts: int

class AuxiliaryChatMessage(TypedDict):
    role: str
    content: str

class AuxiliaryStructuredInput(TypedDict):
    type: Literal["text"]
    text: str

class AuxiliaryLlmCompleteRequest(TypedDict):
    mode: Literal["complete"]
    messages: list[AuxiliaryChatMessage]
    temperature: NotRequired[float]
    maxTokens: NotRequired[float]

class AuxiliaryLlmStructuredRequest(TypedDict):
    mode: Literal["structured"]
    instructions: str
    input: list[AuxiliaryStructuredInput]
    jsonSchema: dict[str, Any]
    schemaName: str
    systemPrompt: NotRequired[str]
    temperature: NotRequired[float]
    maxTokens: NotRequired[float]

class HostCallbackRequest(TypedDict):
    protocolVersion: Literal[1]
    callbackId: str
    kind: Literal["auxiliary_llm"]
    host: str
    sessionId: str
    task: AuxiliaryTaskName
    taskKey: str
    purpose: str
    createdAtMs: float
    deadlineAtMs: float
    attempt: int
    request: AuxiliaryLlmRequest

class HostCallbackSuccess(TypedDict):
    status: Literal["completed"]
    text: str
    parsed: NotRequired[Any]
    provider: NotRequired[str]
    model: NotRequired[str]
    usage: NotRequired[ContextUsageObservation]

class HostCallbackFailure(TypedDict):
    status: HostCallbackFailureStatus
    errorType: str
    message: NotRequired[str]

class ResolveHostCallbackRequest(TypedDict):
    protocolVersion: Literal[1]
    resolutionId: str
    host: str
    sessionId: str
    callbackId: str
    attempt: int
    resolvedAtMs: float
    outcome: HostCallbackOutcome

class HostCallbackResolutionReceipt(TypedDict):
    protocolVersion: Literal[1]
    resolutionId: str
    callbackId: str
    sessionId: str
    accepted: bool
    status: HostCallbackResolutionStatus
    revision: int
    callbacks: NotRequired[list[HostCallbackRequest]]

class MaintenancePollRequest(TypedDict):
    protocolVersion: Literal[1]
    pollId: str
    host: str
    sessionId: str
    polledAtMs: float
    tasks: NotRequired[list[AuxiliaryTaskName]]

class MaintenancePollReceipt(TypedDict):
    protocolVersion: Literal[1]
    pollId: str
    sessionId: str
    revision: int
    callbacks: list[HostCallbackRequest]

class ExecuteContextToolRequest(TypedDict):
    protocolVersion: Literal[1]
    requestId: str
    host: str
    sessionId: str
    projectId: NotRequired[str]
    modelKey: NotRequired[str]
    toolName: ContextToolName
    arguments: dict[str, Any]
    messages: NotRequired[list[CanonicalMessage]]
    invokedAtMs: float

class ContextToolExecutionResult(TypedDict):
    protocolVersion: Literal[1]
    requestId: str
    sessionId: str
    toolName: ContextToolName
    ok: bool
    output: str
    revision: int

class SessionLifecycleRequest(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    host: str
    sessionId: str
    action: SessionLifecycleAction
    observedAtMs: float
    targetSessionId: NotRequired[str]
    projectId: NotRequired[str]
    modelKey: NotRequired[str]
    reason: NotRequired[str]
    messages: NotRequired[list[CanonicalMessage]]
    auxiliaryPolicy: NotRequired[AuxiliaryRuntimePolicy]

class SessionLifecycleReceipt(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    sessionId: str
    action: SessionLifecycleAction
    accepted: bool
    revision: int
    targetSessionId: NotRequired[str]

class CacheFeedbackRequest(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    host: str
    sessionId: str
    observedAtMs: float
    usage: ContextUsageObservation
    projectId: NotRequired[str]
    modelKey: NotRequired[str]

class CacheFeedbackReceipt(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    sessionId: str
    accepted: bool
    revision: int
    cumulativeCacheReadTokens: float
    cumulativeCacheWriteTokens: float

class ToolEventRequest(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    host: str
    sessionId: str
    observedAtMs: float
    phase: ToolEventPhase
    toolName: str
    arguments: NotRequired[dict[str, Any]]
    result: NotRequired[Any]
    status: NotRequired[str]
    durationMs: NotRequired[float]
    toolCallId: NotRequired[str]
    turnId: NotRequired[str]
    taskId: NotRequired[str]

class ToolEventReceipt(TypedDict):
    protocolVersion: Literal[1]
    eventId: str
    sessionId: str
    accepted: bool
    revision: int
    triggersQueued: int

class ContextMutationTarget(TypedDict):
    messageId: str
    blockId: NotRequired[str]
    blockIndex: NotRequired[int]

class ContextMutation(TypedDict):
    target: ContextMutationTarget
    operation: ContextMutationKind
    content: NotRequired[str]

class ContextInjection(TypedDict):
    slot: ContextInjectionSlot
    content: Any
    epoch: int
    fingerprint: str

class ContextRetain(TypedDict):
    messageIds: list[str]
    protectedTailStart: NotRequired[str]

class ContextAccounting(TypedDict):
    estimatedInputTokens: float
    hardLimitTokens: float
    cacheDecision: CacheDecision

class ContextPlan(TypedDict):
    protocolVersion: Literal[1]
    requestId: str
    decision: ContextDecision
    retain: ContextRetain
    mutations: list[ContextMutation]
    injections: list[ContextInjection]
    accounting: ContextAccounting
    reason: NotRequired[str]
    callbacks: NotRequired[list[HostCallbackRequest]]

class RuntimeError(TypedDict):
    code: str
    message: str

class RuntimeSuccess(TypedDict):
    result: ContextRuntimeResult

class RuntimeFailure(TypedDict):
    error: RuntimeError

CanonicalRole: TypeAlias = str

CanonicalBlock: TypeAlias = CanonicalTextBlock | CanonicalToolCallBlock | CanonicalToolResultBlock | CanonicalOpaqueBlock

AuxiliaryLlmRequest: TypeAlias = AuxiliaryLlmCompleteRequest | AuxiliaryLlmStructuredRequest

HostCallbackOutcome: TypeAlias = HostCallbackSuccess | HostCallbackFailure

RuntimeResponse: TypeAlias = RuntimeSuccess | RuntimeFailure

class ContextComposeCall(TypedDict):
    method: Literal["context.compose"]
    params: ComposeContextRequest

class TurnObserveCall(TypedDict):
    method: Literal["turn.observe"]
    params: ObserveTurnRequest

class ToolExecuteCall(TypedDict):
    method: Literal["tool.execute"]
    params: ExecuteContextToolRequest

class SessionLifecycleCall(TypedDict):
    method: Literal["session.lifecycle"]
    params: SessionLifecycleRequest

class CacheObserveCall(TypedDict):
    method: Literal["cache.observe"]
    params: CacheFeedbackRequest

class ToolObserveCall(TypedDict):
    method: Literal["tool.observe"]
    params: ToolEventRequest

class MaintenancePollCall(TypedDict):
    method: Literal["maintenance.poll"]
    params: MaintenancePollRequest

class HostCallbackResolveCall(TypedDict):
    method: Literal["host.callback.resolve"]
    params: ResolveHostCallbackRequest

ContextRuntimeCall: TypeAlias = ContextComposeCall | TurnObserveCall | ToolExecuteCall | SessionLifecycleCall | CacheObserveCall | ToolObserveCall | MaintenancePollCall | HostCallbackResolveCall
ContextRuntimeResult: TypeAlias = ContextPlan | TurnObservationReceipt | ContextToolExecutionResult | SessionLifecycleReceipt | CacheFeedbackReceipt | ToolEventReceipt | MaintenancePollReceipt | HostCallbackResolutionReceipt
RUNTIME_METHODS = {"context.compose":{"params":"ComposeContextRequest","result":"ContextPlan"},"turn.observe":{"params":"ObserveTurnRequest","result":"TurnObservationReceipt"},"tool.execute":{"params":"ExecuteContextToolRequest","result":"ContextToolExecutionResult"},"session.lifecycle":{"params":"SessionLifecycleRequest","result":"SessionLifecycleReceipt"},"cache.observe":{"params":"CacheFeedbackRequest","result":"CacheFeedbackReceipt"},"tool.observe":{"params":"ToolEventRequest","result":"ToolEventReceipt"},"maintenance.poll":{"params":"MaintenancePollRequest","result":"MaintenancePollReceipt"},"host.callback.resolve":{"params":"ResolveHostCallbackRequest","result":"HostCallbackResolutionReceipt"}}
_PROTOCOL_IDL = json.loads("{\"name\":\"MagicContextProtocol\",\"version\":1,\"schemaId\":\"https://cortexkit.dev/schemas/magic-context-protocol-v1.json\",\"enums\":{\"ContextDecision\":{\"values\":[\"serve\",\"defer\",\"safe_fallback\",\"block\"]},\"ContextInjectionSlot\":{\"values\":[\"stable_prefix\",\"volatile_delta\",\"tail_nudge\"]},\"ContextMutationKind\":{\"values\":[\"drop\",\"replace\",\"truncate_tool\",\"edit_marker\",\"prefix_tag\"]},\"CanonicalTextKind\":{\"values\":[\"text\",\"thinking\"]},\"CanonicalOpaqueKind\":{\"values\":[\"image\",\"file\",\"opaque\"]},\"MemoryCategory\":{\"values\":[\"PROJECT_RULES\",\"ARCHITECTURE\",\"CONSTRAINTS\",\"CONFIG_VALUES\",\"NAMING\"],\"constName\":\"MEMORY_CATEGORIES\"},\"MemoryScope\":{\"values\":[\"project\",\"ecosystem\",\"universe\"]},\"MemorySourceType\":{\"values\":[\"historian\",\"agent\",\"dreamer\",\"tool\"]},\"AuxiliaryTaskName\":{\"values\":[\"historian\",\"dreamer\",\"sidekick\"],\"constName\":\"AUXILIARY_TASK_NAMES\"},\"HostCallbackResolutionStatus\":{\"values\":[\"completed\",\"retry_scheduled\",\"failed\"]},\"ContextToolName\":{\"values\":[\"ctx_search\",\"ctx_memory\",\"ctx_expand\",\"ctx_reduce\",\"ctx_note\"],\"constName\":\"CONTEXT_TOOL_NAMES\"},\"SessionLifecycleAction\":{\"values\":[\"start\",\"end\",\"clone\",\"reset\",\"delete\"]},\"ToolEventPhase\":{\"values\":[\"pre\",\"post\"]},\"CacheDecision\":{\"values\":[\"hit_safe\",\"bust_required\"]},\"HostCallbackFailureStatus\":{\"values\":[\"failed\",\"timed_out\"]}},\"aliases\":{\"CanonicalRole\":{\"type\":\"string\"},\"CanonicalBlock\":{\"union\":[\"CanonicalTextBlock\",\"CanonicalToolCallBlock\",\"CanonicalToolResultBlock\",\"CanonicalOpaqueBlock\"]},\"AuxiliaryLlmRequest\":{\"union\":[\"AuxiliaryLlmCompleteRequest\",\"AuxiliaryLlmStructuredRequest\"]},\"HostCallbackOutcome\":{\"union\":[\"HostCallbackSuccess\",\"HostCallbackFailure\"]},\"RuntimeResponse\":{\"union\":[\"RuntimeSuccess\",\"RuntimeFailure\"]}},\"records\":{\"AgentCapabilities\":{\"fields\":{\"preRequestTransform\":{\"type\":\"boolean\"},\"stableMessageIds\":{\"type\":\"boolean\"},\"stablePartIds\":{\"type\":\"boolean\"},\"usageObservation\":{\"type\":\"boolean\"},\"auxiliaryLlm\":{\"type\":\"boolean\"},\"toolRegistration\":{\"type\":\"boolean\"},\"toolEvents\":{\"type\":\"boolean\"},\"requestBlocking\":{\"type\":\"boolean\"},\"systemSuffixInjection\":{\"type\":\"boolean\"},\"promptCacheFacts\":{\"type\":\"boolean\"},\"blockIndexMutations\":{\"type\":\"boolean\",\"optional\":true}}},\"CanonicalTextBlock\":{\"fields\":{\"id\":{\"type\":\"string\",\"optional\":true},\"kind\":{\"type\":\"CanonicalTextKind\"},\"text\":{\"type\":\"string\"}}},\"CanonicalToolCallBlock\":{\"fields\":{\"id\":{\"type\":\"string\",\"optional\":true},\"kind\":{\"type\":\"string\",\"const\":\"tool_call\"},\"callId\":{\"type\":\"string\",\"minLength\":1},\"name\":{\"type\":\"string\",\"minLength\":1},\"input\":{\"type\":\"json\"}}},\"CanonicalToolResultBlock\":{\"fields\":{\"id\":{\"type\":\"string\",\"optional\":true},\"kind\":{\"type\":\"string\",\"const\":\"tool_result\"},\"callId\":{\"type\":\"string\",\"minLength\":1},\"name\":{\"type\":\"string\",\"optional\":true},\"output\":{\"type\":\"json\"},\"isError\":{\"type\":\"boolean\",\"optional\":true}}},\"CanonicalOpaqueBlock\":{\"fields\":{\"id\":{\"type\":\"string\",\"optional\":true},\"kind\":{\"type\":\"CanonicalOpaqueKind\"},\"value\":{\"type\":\"json\"}}},\"CanonicalMessage\":{\"fields\":{\"id\":{\"type\":\"string\",\"minLength\":1},\"ordinal\":{\"type\":\"integer\",\"minimum\":0},\"role\":{\"type\":\"CanonicalRole\",\"minLength\":1},\"content\":{\"type\":\"CanonicalBlock\",\"array\":true},\"createdAtMs\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"synthetic\":{\"type\":\"boolean\",\"optional\":true}}},\"ContextUsageObservation\":{\"fields\":{\"inputTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"outputTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"cacheReadTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"cacheWriteTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"reasoningTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"contextLimitTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true}}},\"ComposeContextRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"requestId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"turnId\":{\"type\":\"string\",\"optional\":true},\"projectId\":{\"type\":\"string\",\"optional\":true},\"modelKey\":{\"type\":\"string\",\"optional\":true},\"budgetTokens\":{\"type\":\"number\",\"minimum\":0},\"capabilities\":{\"type\":\"AgentCapabilities\"},\"messages\":{\"type\":\"CanonicalMessage\",\"array\":true},\"usage\":{\"type\":\"ContextUsageObservation\",\"optional\":true}}},\"TurnOutcomeObservation\":{\"fields\":{\"interrupted\":{\"type\":\"boolean\"},\"failed\":{\"type\":\"boolean\"},\"exitReason\":{\"type\":\"string\",\"optional\":true}}},\"ObservedMemoryCandidate\":{\"fields\":{\"category\":{\"type\":\"MemoryCategory\"},\"content\":{\"type\":\"string\",\"minLength\":1,\"maxLength\":64000},\"importance\":{\"type\":\"number\",\"minimum\":0,\"maximum\":100,\"optional\":true},\"scope\":{\"type\":\"MemoryScope\",\"optional\":true},\"shareable\":{\"type\":\"boolean\",\"optional\":true},\"sourceType\":{\"type\":\"MemorySourceType\",\"optional\":true},\"expiresAtMs\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"metadata\":{\"type\":\"json\",\"map\":true,\"optional\":true}}},\"ObserveTurnRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"observationId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"turnId\":{\"type\":\"string\",\"optional\":true},\"taskId\":{\"type\":\"string\",\"optional\":true},\"projectId\":{\"type\":\"string\",\"optional\":true},\"modelKey\":{\"type\":\"string\",\"optional\":true},\"observedAtMs\":{\"type\":\"number\",\"minimum\":0},\"messages\":{\"type\":\"CanonicalMessage\",\"array\":true},\"usage\":{\"type\":\"ContextUsageObservation\",\"optional\":true},\"outcome\":{\"type\":\"TurnOutcomeObservation\"},\"memoryCandidates\":{\"type\":\"ObservedMemoryCandidate\",\"array\":true,\"maxItems\":128,\"optional\":true}}},\"TurnObservationReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"observationId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"accepted\":{\"type\":\"boolean\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"observedAtMs\":{\"type\":\"number\",\"minimum\":0},\"callbacks\":{\"type\":\"HostCallbackRequest\",\"array\":true,\"optional\":true}}},\"AuxiliaryRuntimePolicy\":{\"fields\":{\"historianEnabled\":{\"type\":\"boolean\"},\"historianThresholdPercentage\":{\"type\":\"number\",\"minimum\":0},\"historianMinMessages\":{\"type\":\"integer\",\"minimum\":0},\"historianProtectedTailMessages\":{\"type\":\"integer\",\"minimum\":0},\"historianTimeoutMs\":{\"type\":\"number\",\"minimum\":0},\"dreamerEnabled\":{\"type\":\"boolean\"},\"dreamerIntervalMs\":{\"type\":\"number\",\"minimum\":0},\"dreamerTimeoutMs\":{\"type\":\"number\",\"minimum\":0},\"sidekickEnabled\":{\"type\":\"boolean\"},\"sidekickTimeoutMs\":{\"type\":\"number\",\"minimum\":0},\"maxAttempts\":{\"type\":\"integer\",\"minimum\":1}}},\"AuxiliaryChatMessage\":{\"fields\":{\"role\":{\"type\":\"string\"},\"content\":{\"type\":\"string\"}}},\"AuxiliaryStructuredInput\":{\"fields\":{\"type\":{\"type\":\"string\",\"const\":\"text\"},\"text\":{\"type\":\"string\"}}},\"AuxiliaryLlmCompleteRequest\":{\"fields\":{\"mode\":{\"type\":\"string\",\"const\":\"complete\"},\"messages\":{\"type\":\"AuxiliaryChatMessage\",\"array\":true},\"temperature\":{\"type\":\"number\",\"optional\":true},\"maxTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true}}},\"AuxiliaryLlmStructuredRequest\":{\"fields\":{\"mode\":{\"type\":\"string\",\"const\":\"structured\"},\"instructions\":{\"type\":\"string\"},\"input\":{\"type\":\"AuxiliaryStructuredInput\",\"array\":true},\"jsonSchema\":{\"type\":\"json\",\"map\":true},\"schemaName\":{\"type\":\"string\"},\"systemPrompt\":{\"type\":\"string\",\"optional\":true},\"temperature\":{\"type\":\"number\",\"optional\":true},\"maxTokens\":{\"type\":\"number\",\"minimum\":0,\"optional\":true}}},\"HostCallbackRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"callbackId\":{\"type\":\"string\",\"minLength\":1},\"kind\":{\"type\":\"string\",\"const\":\"auxiliary_llm\"},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"task\":{\"type\":\"AuxiliaryTaskName\"},\"taskKey\":{\"type\":\"string\"},\"purpose\":{\"type\":\"string\"},\"createdAtMs\":{\"type\":\"number\",\"minimum\":0},\"deadlineAtMs\":{\"type\":\"number\",\"minimum\":0},\"attempt\":{\"type\":\"integer\",\"minimum\":1},\"request\":{\"type\":\"AuxiliaryLlmRequest\"}}},\"HostCallbackSuccess\":{\"fields\":{\"status\":{\"type\":\"string\",\"const\":\"completed\"},\"text\":{\"type\":\"string\"},\"parsed\":{\"type\":\"json\",\"optional\":true},\"provider\":{\"type\":\"string\",\"optional\":true},\"model\":{\"type\":\"string\",\"optional\":true},\"usage\":{\"type\":\"ContextUsageObservation\",\"optional\":true}}},\"HostCallbackFailure\":{\"fields\":{\"status\":{\"type\":\"HostCallbackFailureStatus\"},\"errorType\":{\"type\":\"string\"},\"message\":{\"type\":\"string\",\"optional\":true}}},\"ResolveHostCallbackRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"resolutionId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"callbackId\":{\"type\":\"string\",\"minLength\":1},\"attempt\":{\"type\":\"integer\",\"minimum\":1},\"resolvedAtMs\":{\"type\":\"number\",\"minimum\":0},\"outcome\":{\"type\":\"HostCallbackOutcome\"}}},\"HostCallbackResolutionReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"resolutionId\":{\"type\":\"string\"},\"callbackId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"accepted\":{\"type\":\"boolean\"},\"status\":{\"type\":\"HostCallbackResolutionStatus\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"callbacks\":{\"type\":\"HostCallbackRequest\",\"array\":true,\"optional\":true}}},\"MaintenancePollRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"pollId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"polledAtMs\":{\"type\":\"number\",\"minimum\":0},\"tasks\":{\"type\":\"AuxiliaryTaskName\",\"array\":true,\"optional\":true}}},\"MaintenancePollReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"pollId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"callbacks\":{\"type\":\"HostCallbackRequest\",\"array\":true}}},\"ExecuteContextToolRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"requestId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"projectId\":{\"type\":\"string\",\"optional\":true},\"modelKey\":{\"type\":\"string\",\"optional\":true},\"toolName\":{\"type\":\"ContextToolName\"},\"arguments\":{\"type\":\"json\",\"map\":true},\"messages\":{\"type\":\"CanonicalMessage\",\"array\":true,\"optional\":true},\"invokedAtMs\":{\"type\":\"number\",\"minimum\":0}}},\"ContextToolExecutionResult\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"requestId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"toolName\":{\"type\":\"ContextToolName\"},\"ok\":{\"type\":\"boolean\"},\"output\":{\"type\":\"string\"},\"revision\":{\"type\":\"integer\",\"minimum\":0}}},\"SessionLifecycleRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"action\":{\"type\":\"SessionLifecycleAction\"},\"observedAtMs\":{\"type\":\"number\",\"minimum\":0},\"targetSessionId\":{\"type\":\"string\",\"optional\":true},\"projectId\":{\"type\":\"string\",\"optional\":true},\"modelKey\":{\"type\":\"string\",\"optional\":true},\"reason\":{\"type\":\"string\",\"optional\":true},\"messages\":{\"type\":\"CanonicalMessage\",\"array\":true,\"optional\":true},\"auxiliaryPolicy\":{\"type\":\"AuxiliaryRuntimePolicy\",\"optional\":true}}},\"SessionLifecycleReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"action\":{\"type\":\"SessionLifecycleAction\"},\"accepted\":{\"type\":\"boolean\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"targetSessionId\":{\"type\":\"string\",\"optional\":true}}},\"CacheFeedbackRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"observedAtMs\":{\"type\":\"number\",\"minimum\":0},\"usage\":{\"type\":\"ContextUsageObservation\"},\"projectId\":{\"type\":\"string\",\"optional\":true},\"modelKey\":{\"type\":\"string\",\"optional\":true}}},\"CacheFeedbackReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"accepted\":{\"type\":\"boolean\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"cumulativeCacheReadTokens\":{\"type\":\"number\",\"minimum\":0},\"cumulativeCacheWriteTokens\":{\"type\":\"number\",\"minimum\":0}}},\"ToolEventRequest\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\",\"minLength\":1},\"host\":{\"type\":\"string\",\"minLength\":1},\"sessionId\":{\"type\":\"string\",\"minLength\":1},\"observedAtMs\":{\"type\":\"number\",\"minimum\":0},\"phase\":{\"type\":\"ToolEventPhase\"},\"toolName\":{\"type\":\"string\",\"minLength\":1},\"arguments\":{\"type\":\"json\",\"map\":true,\"optional\":true},\"result\":{\"type\":\"json\",\"optional\":true},\"status\":{\"type\":\"string\",\"optional\":true},\"durationMs\":{\"type\":\"number\",\"minimum\":0,\"optional\":true},\"toolCallId\":{\"type\":\"string\",\"optional\":true},\"turnId\":{\"type\":\"string\",\"optional\":true},\"taskId\":{\"type\":\"string\",\"optional\":true}}},\"ToolEventReceipt\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"eventId\":{\"type\":\"string\"},\"sessionId\":{\"type\":\"string\"},\"accepted\":{\"type\":\"boolean\"},\"revision\":{\"type\":\"integer\",\"minimum\":0},\"triggersQueued\":{\"type\":\"integer\",\"minimum\":0}}},\"ContextMutationTarget\":{\"fields\":{\"messageId\":{\"type\":\"string\",\"minLength\":1},\"blockId\":{\"type\":\"string\",\"optional\":true},\"blockIndex\":{\"type\":\"integer\",\"minimum\":0,\"optional\":true}}},\"ContextMutation\":{\"fields\":{\"target\":{\"type\":\"ContextMutationTarget\"},\"operation\":{\"type\":\"ContextMutationKind\"},\"content\":{\"type\":\"string\",\"optional\":true}}},\"ContextInjection\":{\"fields\":{\"slot\":{\"type\":\"ContextInjectionSlot\"},\"content\":{\"type\":\"json\"},\"epoch\":{\"type\":\"integer\",\"minimum\":0},\"fingerprint\":{\"type\":\"string\"}}},\"ContextRetain\":{\"fields\":{\"messageIds\":{\"type\":\"string\",\"array\":true},\"protectedTailStart\":{\"type\":\"string\",\"optional\":true}}},\"ContextAccounting\":{\"fields\":{\"estimatedInputTokens\":{\"type\":\"number\",\"minimum\":0},\"hardLimitTokens\":{\"type\":\"number\",\"minimum\":0},\"cacheDecision\":{\"type\":\"CacheDecision\"}}},\"ContextPlan\":{\"fields\":{\"protocolVersion\":{\"type\":\"integer\",\"const\":1},\"requestId\":{\"type\":\"string\"},\"decision\":{\"type\":\"ContextDecision\"},\"retain\":{\"type\":\"ContextRetain\"},\"mutations\":{\"type\":\"ContextMutation\",\"array\":true},\"injections\":{\"type\":\"ContextInjection\",\"array\":true},\"accounting\":{\"type\":\"ContextAccounting\"},\"reason\":{\"type\":\"string\",\"optional\":true},\"callbacks\":{\"type\":\"HostCallbackRequest\",\"array\":true,\"optional\":true}}},\"RuntimeError\":{\"fields\":{\"code\":{\"type\":\"string\"},\"message\":{\"type\":\"string\"}}},\"RuntimeSuccess\":{\"fields\":{\"result\":{\"type\":\"ContextRuntimeResult\"}}},\"RuntimeFailure\":{\"fields\":{\"error\":{\"type\":\"RuntimeError\"}}}},\"methods\":{\"context.compose\":{\"params\":\"ComposeContextRequest\",\"result\":\"ContextPlan\"},\"turn.observe\":{\"params\":\"ObserveTurnRequest\",\"result\":\"TurnObservationReceipt\"},\"tool.execute\":{\"params\":\"ExecuteContextToolRequest\",\"result\":\"ContextToolExecutionResult\"},\"session.lifecycle\":{\"params\":\"SessionLifecycleRequest\",\"result\":\"SessionLifecycleReceipt\"},\"cache.observe\":{\"params\":\"CacheFeedbackRequest\",\"result\":\"CacheFeedbackReceipt\"},\"tool.observe\":{\"params\":\"ToolEventRequest\",\"result\":\"ToolEventReceipt\"},\"maintenance.poll\":{\"params\":\"MaintenancePollRequest\",\"result\":\"MaintenancePollReceipt\"},\"host.callback.resolve\":{\"params\":\"ResolveHostCallbackRequest\",\"result\":\"HostCallbackResolutionReceipt\"}}}")

def _validate_spec(spec: dict[str, Any], value: Any) -> bool:
    if 'union' in spec:
        return any(_validate_named(name, value) for name in spec['union'])
    if isinstance(spec.get('type'), list):
        return any(_validate_named(name, value) for name in spec['type'])
    if spec.get('array'):
        if not isinstance(value, list): return False
        if 'minItems' in spec and len(value) < spec['minItems']: return False
        if 'maxItems' in spec and len(value) > spec['maxItems']: return False
        child = {k: v for k, v in spec.items() if k not in {'array', 'optional', 'minItems', 'maxItems'}}
        return all(_validate_spec(child, item) for item in value)
    if spec.get('map'):
        if not isinstance(value, dict): return False
        child = {k: v for k, v in spec.items() if k not in {'map', 'optional'}}
        return all(_validate_spec(child, item) for item in value.values())
    if 'const' in spec and value != spec['const']: return False
    kind = spec.get('type')
    if kind == 'json': valid = True
    elif kind == 'string': valid = isinstance(value, str)
    elif kind == 'number': valid = isinstance(value, (int, float)) and not isinstance(value, bool)
    elif kind == 'integer': valid = isinstance(value, int) and not isinstance(value, bool)
    elif kind == 'boolean': valid = isinstance(value, bool)
    else: valid = _validate_named(kind, value)
    if not valid: return False
    if isinstance(value, str):
        if 'minLength' in spec and len(value) < spec['minLength']: return False
        if 'maxLength' in spec and len(value) > spec['maxLength']: return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 'minimum' in spec and value < spec['minimum']: return False
        if 'maximum' in spec and value > spec['maximum']: return False
    return True

def _validate_named(name: str, value: Any) -> bool:
    enum = _PROTOCOL_IDL['enums'].get(name)
    if enum is not None: return value in enum['values']
    alias = _PROTOCOL_IDL['aliases'].get(name)
    if alias is not None: return _validate_spec(alias, value)
    if name == 'ContextRuntimeCall': return validate_runtime_call(value)
    if name == 'ContextRuntimeResult':
        return any(_validate_named(method['result'], value) for method in _PROTOCOL_IDL['methods'].values())
    record = _PROTOCOL_IDL['records'].get(name)
    if record is None or not isinstance(value, dict): return False
    if any(key not in record['fields'] for key in value): return False
    for field_name, field in record['fields'].items():
        if field_name not in value:
            if field.get('optional'): continue
            return False
        if not _validate_spec(field, value[field_name]): return False
    return True

def validate_runtime_call(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {'method', 'params'}: return False
    method = _PROTOCOL_IDL['methods'].get(value.get('method'))
    return method is not None and _validate_named(method['params'], value.get('params'))

def validate_runtime_result(method_name: str, value: Any) -> bool:
    method = _PROTOCOL_IDL['methods'].get(method_name)
    return method is not None and _validate_named(method['result'], value)

