export const EXIT_CODES = {
  unknown_command: 1,
  missing_flag: 1,
  invalid_flag: 1,
  invalid_job_id: 1,
  unknown_tenant: 2,
  invalid_token: 2,
  forbidden_role: 2,
  job_not_visible: 2,
  invalid_transition: 3,
  no_available_job: 3,
  storage_unreadable: 4,
  storage_unsupported_version: 4,
  storage_write_failed: 4,
};

export class QueueDeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QueueDeskError";
    this.code = code;
  }

  get exitCode() {
    return EXIT_CODES[this.code];
  }
}

export function fail(code, message) {
  if (!Object.hasOwn(EXIT_CODES, code)) {
    throw new Error(`unknown error code: ${code}`);
  }
  return new QueueDeskError(code, message);
}
