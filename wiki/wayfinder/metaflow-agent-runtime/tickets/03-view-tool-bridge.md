## Question

How should agents use Metaflow View CLI or MCP tools to find related Views
after receiving the user's prompt and current context?

## Depends On

- Define RuntimeAdapter contracts
- Implement View access policy in the View Core map

## Acceptance Criteria

- Agents receive View CLI or MCP tools instead of direct database access.
- Read tools search, get, traverse, and materialize only authorized Views.
- The agent decides which related Views to search based on its own skills.
- Write tools create artifacts or proposed Views; Execution Runtime validates
  before commit.
- The first slice only needs current voice plus current screen/app context;
  broader retrieval can be optimized later.

## Verification Method

- Test an agent receiving a voice prompt and current screen context, then using
  View CLI or MCP search to find project.current and related Views.
- Prove denied Views are not disclosed even when the agent asks broadly.
