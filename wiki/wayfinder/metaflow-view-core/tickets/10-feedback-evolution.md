## Question

How should Feedback Views target exact outputs or Runs and drive explicit Transformation and View evolution without mutating prior results?

## Depends on

- Implement extensible View-to-View Operators

## Acceptance criteria

- Feedback is a normal View referencing an exact target revision and optional Run.
- Applying feedback creates a new Transformation revision, new Run, or both.
- The old Transformation and View revisions remain queryable.
- Feedback may revise instruction, Operator configuration, output Schema, or selection behavior explicitly.
- Concurrent feedback changes encounter normal base-revision conflict handling.

## Verification method

- Exercise a concrete learning-material example from initial output through negative feedback to an improved revision.
- Assert complete provenance from improved output back through feedback, Run, Transformation, and source Views.
