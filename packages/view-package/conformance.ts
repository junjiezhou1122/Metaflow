import { validateViewRepresentation } from "@info/view";
import {
  ViewPackageFixtureSchema,
  rendererKey,
  schemaKey,
  transformationKey,
  type ViewPackageConformanceInput,
  type ViewPackageConformanceReport,
} from "./contracts.js";
import { ViewPackageError } from "./package.js";

export function runViewPackageConformance(input: ViewPackageConformanceInput): ViewPackageConformanceReport {
  const manifest = input.package.manifest;

  for (const renderer of manifest.renderers) {
    const key = rendererKey(renderer);
    if (!input.renderers.has(key)) {
      throw new ViewPackageError(
        `View Package renderer is not installed: ${key}`,
        "missing_renderer",
        {
          renderer_id: renderer.id,
          renderer_version: renderer.version,
          renderer_abi_version: renderer.abi_version,
        },
      );
    }
  }

  for (const method of manifest.methods) {
    if (method.target.kind === "operation") {
      if (!input.operations.has(method.target.operation)) {
        throw new ViewPackageError(
          `View Package method ${method.id} references an unknown Operation: ${method.target.operation}`,
          "missing_operation",
          { method_id: method.id, operation: method.target.operation },
        );
      }
      continue;
    }
    assertTransformationOutput(input, method.target.transformation, method.schema, `method ${method.id}`);
  }

  for (const evolution of manifest.evolutions) {
    assertTransformationOutput(input, evolution.transformation, evolution.to, `evolution ${evolution.id}`);
  }

  const fixtureIds = new Set<string>();
  for (const rawFixture of input.fixtures) {
    const parsed = ViewPackageFixtureSchema.safeParse(rawFixture);
    if (!parsed.success) {
      throw new ViewPackageError(
        "View Package fixture failed validation",
        "invalid_fixture",
        { issue_count: parsed.error.issues.length },
        { cause: parsed.error },
      );
    }
    const fixture = parsed.data;
    if (fixtureIds.has(fixture.id)) {
      throw new ViewPackageError(`Duplicate View Package fixture: ${fixture.id}`, "invalid_fixture", { fixture_id: fixture.id });
    }
    fixtureIds.add(fixture.id);
    const schema = input.package.schema(fixture.schema);
    const profiles = manifest.representations.filter(profile => schemaKey(profile.schema) === schemaKey(fixture.schema));
    const matches = profiles.some(profile =>
      profile.forms.includes(fixture.representation.form)
      && profile.kinds.includes(fixture.representation.kind)
      && (profile.media_types.length === 0
        || (fixture.representation.media_type !== undefined && profile.media_types.includes(fixture.representation.media_type))),
    );
    if (!matches) {
      throw new ViewPackageError(
        `Fixture ${fixture.id} does not match a declared Representation profile`,
        "representation_profile_mismatch",
        { fixture_id: fixture.id, schema: schemaKey(fixture.schema) },
      );
    }
    try {
      validateViewRepresentation(schema, fixture.representation);
    } catch (error) {
      throw new ViewPackageError(
        `Fixture ${fixture.id} does not satisfy Schema ${schemaKey(schema)}`,
        "invalid_fixture",
        { fixture_id: fixture.id, schema: schemaKey(schema) },
        { cause: error },
      );
    }
  }

  return {
    package_id: manifest.id,
    package_version: manifest.version,
    schemas: manifest.schemas.length,
    fixtures: fixtureIds.size,
    methods: manifest.methods.length,
    renderers: manifest.renderers.length,
    evolutions: manifest.evolutions.length,
  };
}

function assertTransformationOutput(
  input: ViewPackageConformanceInput,
  ref: { transformation_id: string; revision: number },
  expected: { name: string; version: number },
  owner: string,
): void {
  const key = transformationKey(ref);
  const transformation = input.transformations.get(key);
  if (!transformation) {
    throw new ViewPackageError(
      `View Package ${owner} references an unavailable Transformation: ${key}`,
      "missing_transformation",
      { transformation: key },
    );
  }
  if (schemaKey(transformation.output_schema) !== schemaKey(expected)) {
    throw new ViewPackageError(
      `Transformation ${key} outputs ${schemaKey(transformation.output_schema)}, expected ${schemaKey(expected)}`,
      "transformation_output_mismatch",
      { transformation: key, expected_schema: schemaKey(expected), actual_schema: schemaKey(transformation.output_schema) },
    );
  }
}
