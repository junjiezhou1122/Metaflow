import {
  OperationNameSchema,
  OperationEnvelopeSchema,
  type OperationContextProvider,
  type OperationEnvelope,
  type OperationService,
} from "@info/operations";
import { OPERATION_EXIT_CODE_BY_CATEGORY, operationExitCode } from "./wire-contract.js";

export type CliOperationResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  envelope: OperationEnvelope;
};

export { OPERATION_EXIT_CODE_BY_CATEGORY } from "./wire-contract.js";

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
  return operationExitCode(envelope);
}
