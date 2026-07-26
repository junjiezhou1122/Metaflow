import {
  OperationNameSchema,
  OperationEnvelopeSchema,
  type OperationContextProvider,
  type OperationEnvelope,
  type OperationService,
} from "@info/operations";

export type CliOperationResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  envelope: OperationEnvelope;
};

export const OPERATION_EXIT_CODE_BY_CATEGORY = {
  invalid_request: 2,
  forbidden: 3,
  not_found: 4,
  conflict: 5,
  failed_dependency: 6,
  internal: 1,
} as const;

export class CliOperationAdapter {
  constructor(
    private readonly service: OperationService,
    private readonly context: OperationContextProvider,
  ) {}

  async invoke(argv: readonly string[]): Promise<CliOperationResult> {
    const operation = argv[0];
    const rawInput = argv[1] ?? "{}";
    let input: unknown;
    try {
      input = JSON.parse(rawInput);
    } catch {
      const context = await this.context({ transport: "cli", ...(operation ? { operation } : {}) });
      const parsedOperation = OperationNameSchema.safeParse(operation);
      const envelope = OperationEnvelopeSchema.parse({
        ok: false,
        request_id: context.request_id,
        ...(parsedOperation.success ? { operation: parsedOperation.data } : {}),
        error: {
          code: "cli_input_invalid",
          message: "CLI input must be valid JSON",
          category: "invalid_request",
          details: {},
        },
      });
      return resultFor(envelope);
    }
    const context = await this.context({ transport: "cli", ...(operation ? { operation } : {}) });
    const envelope = OperationEnvelopeSchema.parse(await this.service.execute({ operation, input }, context));
    return resultFor(envelope);
  }
}

function resultFor(envelope: OperationEnvelope): CliOperationResult {
  return {
    exit_code: cliExitCode(envelope),
    stdout: `${JSON.stringify(envelope)}\n`,
    stderr: envelope.ok ? "" : `mf: ${envelope.error.code}: ${envelope.error.message}\n`,
    envelope,
  };
}

function cliExitCode(envelope: OperationEnvelope): number {
  if (envelope.ok) return 0;
  return OPERATION_EXIT_CODE_BY_CATEGORY[envelope.error.category];
}
