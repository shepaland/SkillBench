export class SkillBenchError extends Error {
  public constructor(
    message: string,
    public readonly exitCode: 1 | 2,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class FindingError extends SkillBenchError {
  public constructor(message: string) {
    super(message, 1);
  }
}

export class ValidationError extends SkillBenchError {
  public constructor(message: string) {
    super(message, 2);
  }
}

export class InvocationError extends SkillBenchError {
  public constructor(message: string) {
    super(message, 2);
  }
}

export class DependencyError extends SkillBenchError {
  public constructor(message: string) {
    super(message, 2);
  }
}
