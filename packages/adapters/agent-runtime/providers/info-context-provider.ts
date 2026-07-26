export type InfoContextProviderDescriptor = {
  id: "info_context";
  purpose: "resolve_context_sources";
  recordUriPrefix: "context://records/";
  viewUriPrefix: "context://views/";
};

export function infoContextProviderDescriptor(): InfoContextProviderDescriptor {
  return {
    id: "info_context",
    purpose: "resolve_context_sources",
    recordUriPrefix: "context://records/",
    viewUriPrefix: "context://views/",
  };
}
