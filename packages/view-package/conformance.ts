import { validateViewRelationProjection, validateViewRepresentation } from "@info/view";
import {
  ViewPackageFixtureSchema,
  normalizeMediaType,
  parserKey,
  rendererKey,
  schemaKey,
  transformationKey,
  type ViewPackageConformanceInput,
  type ViewPackageConformanceReport,
  type ViewPackageParser,
  type ViewPackageRepresentationProfile,
  type ViewPackageTransformationConformance,
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

  for (const parser of manifest.parsers) {
    const transformation = assertTransformationOutput(
      input,
      parser.transformation,
      parser.output_schema,
      `parser ${parserKey(parser)}`,
    );
    const inputRoles = transformation.input_roles;
    const source = inputRoles?.length === 1 ? inputRoles[0] : undefined;
    if (
      source?.role !== "source"
      || source.required !== true
      || !source.schemas.map(schemaKey).includes(schemaKey(parser.input_schema))
    ) {
      throw new ViewPackageError(
        `Parser ${parserKey(parser)} requires one exact source role that admits its input Schema`,
        "transformation_input_mismatch",
        { parser: parserKey(parser), transformation: transformationKey(parser.transformation) },
      );
    }
    const profiles = manifest.representations.filter(profile => schemaKey(profile.schema) === schemaKey(parser.input_schema));
    if (!profiles.some(profile => representationProfilesOverlap(profile, parser))) {
      throw new ViewPackageError(
        `View Package parser ${parserKey(parser)} accepts no declared Representation profile`,
        "parser_profile_mismatch",
        { parser: parserKey(parser), input_schema: schemaKey(parser.input_schema) },
      );
    }
  }

  for (const processor of manifest.processors) {
    const transformation = assertTransformationOutput(
      input,
      processor.transformation,
      processor.output_schema,
      `processor ${processor.id}@${processor.version}`,
    );
    const expectedRoles = processor.inputs.map(inputRoleKey).sort();
    const actualRoles = transformation.input_roles?.map(inputRoleKey).sort();
    if (actualRoles === undefined || JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
      throw new ViewPackageError(
        `Processor ${processor.id}@${processor.version} input roles do not match its exact Transformation`,
        "transformation_input_mismatch",
        { processor_id: processor.id, processor_version: processor.version, transformation: transformationKey(processor.transformation) },
      );
    }
  }

  const fixtureIds = new Set<string>();
  const parserFixtures = new Set<string>();
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
    if (fixture.representation.media_type !== undefined) {
      try {
        normalizeMediaType(fixture.representation.media_type);
      } catch (error) {
        throw new ViewPackageError(
          `Fixture ${fixture.id} has an invalid Representation media type`,
          "invalid_fixture",
          { fixture_id: fixture.id, schema: schemaKey(fixture.schema) },
          { cause: error },
        );
      }
    }
    const profiles = manifest.representations.filter(profile => schemaKey(profile.schema) === schemaKey(fixture.schema));
    const matches = profiles.some(profile =>
      profile.forms.includes(fixture.representation.form)
      && profile.kinds.includes(fixture.representation.kind)
      && (profile.media_types.length === 0
        || (fixture.representation.media_type !== undefined
          && profile.media_types.map(normalizeMediaType).includes(normalizeMediaType(fixture.representation.media_type)))),
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
      validateViewRelationProjection(schema, fixture.representation, fixture.relations);
    } catch (error) {
      throw new ViewPackageError(
        `Fixture ${fixture.id} does not satisfy Schema ${schemaKey(schema)}`,
        "invalid_fixture",
        { fixture_id: fixture.id, schema: schemaKey(schema) },
        { cause: error },
      );
    }
    manifest.parsers
      .filter(parser => schemaKey(parser.input_schema) === schemaKey(fixture.schema))
      .filter(parser => parserAccepts(parser, fixture.representation))
      .forEach(parser => {
        const mediaType = parser.accepts.media_types.length === 0
          ? "*"
          : normalizeMediaType(fixture.representation.media_type!);
        parserFixtures.add(parserFixtureKey(parser, fixture.representation.form, fixture.representation.kind, mediaType));
      });
  }

  for (const parser of manifest.parsers) {
    for (const requiredFixture of parserFixtureKeys(parser)) {
      if (parserFixtures.has(requiredFixture)) continue;
      throw new ViewPackageError(
        `View Package parser ${parserKey(parser)} has no fixture for every accepted Representation tuple`,
        "missing_parser_fixture",
        { parser: parserKey(parser), input_schema: schemaKey(parser.input_schema), acceptance: requiredFixture },
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
    parsers: manifest.parsers.length,
    processors: manifest.processors.length,
    evolutions: manifest.evolutions.length,
  };
}

function assertTransformationOutput(
  input: ViewPackageConformanceInput,
  ref: { transformation_id: string; revision: number },
  expected: { name: string; version: number },
  owner: string,
): ViewPackageTransformationConformance {
  const key = transformationKey(ref);
  const transformation = input.transformations.get(key);
  if (!transformation) {
    throw new ViewPackageError(
      `View Package ${owner} references an unavailable Transformation: ${key}`,
      "missing_transformation",
      { transformation: key },
    );
  }
  if (transformationKey(transformation.ref) !== key) {
    throw new ViewPackageError(
      `Transformation registry entry ${key} contains ${transformationKey(transformation.ref)}`,
      "transformation_reference_mismatch",
      { transformation: key, actual_transformation: transformationKey(transformation.ref) },
    );
  }
  if (schemaKey(transformation.output_schema) !== schemaKey(expected)) {
    throw new ViewPackageError(
      `Transformation ${key} outputs ${schemaKey(transformation.output_schema)}, expected ${schemaKey(expected)}`,
      "transformation_output_mismatch",
      { transformation: key, expected_schema: schemaKey(expected), actual_schema: schemaKey(transformation.output_schema) },
    );
  }
  return transformation;
}

function representationProfilesOverlap(
  profile: ViewPackageRepresentationProfile,
  parser: ViewPackageParser,
): boolean {
  return profile.forms.some(form => parser.accepts.forms.includes(form))
    && profile.kinds.some(kind => parser.accepts.representation_kinds.includes(kind))
    && (profile.media_types.length === 0
      || parser.accepts.media_types.length === 0
      || profile.media_types.map(normalizeMediaType).some(mediaType =>
        parser.accepts.media_types.map(normalizeMediaType).includes(mediaType)));
}

function parserAccepts(parser: ViewPackageParser, representation: Parameters<typeof validateViewRepresentation>[1]): boolean {
  return parser.accepts.forms.includes(representation.form)
    && parser.accepts.representation_kinds.includes(representation.kind)
    && (parser.accepts.media_types.length === 0
      || (representation.media_type !== undefined
        && parser.accepts.media_types.map(normalizeMediaType).includes(normalizeMediaType(representation.media_type))));
}

function inputRoleKey(input: {
  role: string;
  required: boolean;
  schemas: ReadonlyArray<{ name: string; version: number }>;
}): string {
  return `${input.role}:${input.required}:${input.schemas.map(schemaKey).sort().join(",")}`;
}

function parserFixtureKeys(parser: ViewPackageParser): string[] {
  const mediaTypes = parser.accepts.media_types.length === 0
    ? ["*"]
    : parser.accepts.media_types.map(normalizeMediaType);
  return parser.accepts.forms.flatMap(form => parser.accepts.representation_kinds.flatMap(kind =>
    mediaTypes.map(mediaType => parserFixtureKey(parser, form, kind, mediaType))));
}

function parserFixtureKey(parser: ViewPackageParser, form: string, kind: string, mediaType: string): string {
  return `${parserKey(parser)}:${form}:${kind}:${mediaType}`;
}
