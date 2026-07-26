import {
  type SearchPrincipal,
  type ViewReadAuthorizationDecision,
  type ViewReadAuthorizationPort,
} from "@info/search";
import { type ExactViewRef, type ViewRepository } from "@info/view";

export class RepositoryViewReadAuthorizer implements ViewReadAuthorizationPort {
  constructor(private readonly views: Pick<ViewRepository, "get">) {}

  async authorize(input: {
    principal: SearchPrincipal;
    refs: ExactViewRef[];
    purpose: "read" | "search" | "traverse" | "graph_project";
  }): Promise<ViewReadAuthorizationDecision[]> {
    return Promise.all(input.refs.map(async ref => {
      const view = await this.views.get(ref);
      if (!view) return { ref, status: "missing" as const, code: "view_not_found" };
      if (view.policy.owner === input.principal.id || view.policy.visibility === "public") {
        return { ref, status: "allowed" as const };
      }
      return {
        ref,
        status: "denied" as const,
        code: view.policy.visibility === "shared" ? "sharing_acl_unavailable" : "view_read_forbidden",
      };
    }));
  }
}
