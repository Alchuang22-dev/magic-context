# Magic Context Adapter Kit

`RuntimeAgentController` owns compose/observe/lifecycle/cache/tool calls and the
fenced reverse-callback chain. A host Adapter supplies only:

- a native message codec implementing `AgentContextAdapter`;
- host facts such as session, model, usage, and context limit;
- an optional auxiliary-LLM Adapter.

Tagging, scheduling, storage, memory, and injection policy are not exposed at
this seam.
