export type WebRendererErrorCode =
  | "invalid_descriptor"
  | "invalid_registration"
  | "duplicate_registration"
  | "no_matching_renderer"
  | "missing_registration"
  | "abi_mismatch"
  | "invalid_input"
  | "load_failed"
  | "mount_failed"
  | "aborted"
  | "asset_not_authorized"
  | "asset_resolution_failed"
  | "method_not_declared"
  | "method_invocation_failed"
  | "unsafe_link"
  | "link_open_failed"
  | "dispose_failed";

export class WebRendererError extends Error {
  constructor(
    message: string,
    readonly code: WebRendererErrorCode,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebRendererError";
  }
}
