type AnyStr = string & {};

export interface ValidateOpts {
  fields: Record<
    string,
    | string
    | {
        type: 'string' | 'boolean' | 'number' | 'object' | 'array' | AnyStr;
        required?: boolean; // default: true
        convertible?: boolean; // default: true (only support number and boolean type)
        min?: number;
        max?: number;
        fail_message?: string;
        validate_func?: (value: any) => boolean;
      }
  >;
}

export class ValidateResult {
  #status: boolean;
  #err?: string | Record<string, string | number>;
  #result?: any;

  constructor(result?: any, err?: string | Record<string, string | number>) {
    this.#status = err === undefined;
    this.#err = err;
    this.#result = result;
    if ((this.#status && this.#result === undefined) || (!this.#status && this.#result !== undefined)) {
      throw Error('Cannot specify the error and the result at the same time.');
    }
  }

  static err(err?: string | Record<string, string | number>) {
    return new ValidateResult(undefined, err);
  }

  static ok(result?: any) {
    return new ValidateResult(result, undefined);
  }

  toString() {
    return JSON.stringify({
      status: this.#status ? 'pass' : 'failed',
      err: this.#err,
    });
  }

  valueOf() {
    return this.#status ? 1 : 0;
  }

  is_ok() {
    return this.#status === true;
  }

  get status() {
    return this.#status;
  }

  get err() {
    return this.#err;
  }

  get result() {
    return this.#result;
  }
}

export function validate(object: Record<string, any>, opts: ValidateOpts): ValidateResult {
  const result = Object.assign({}, object);
  const fields = Object.entries(opts.fields).map(([key, value]) => {
    if (typeof value === 'string') {
      return {
        field: key,
        type: value,
        required: true,
        convertible: true,
      };
    } else if (typeof value === 'object')
      return {
        field: key,
        ...value,
      };
    else {
      throw new Error('Invalid ValidateOpts.');
    }
  });

  for (const field of fields) {
    const key = field.field;

    if (!Object.hasOwn(object, key)) {
      if (field.required === false) continue;
      else return ValidateResult.err(field.fail_message ?? `Missing required field \`${key}\`.`);
    }

    const target = object[key];
    if (field.validate_func) {
      if (!field.validate_func(target))
        return ValidateResult.err(field.fail_message ?? `Validation failed on field \`${key}\`.`);
      continue;
    }

    switch (field.type) {
      case 'number': {
        if (typeof target !== 'number' && !(typeof target === 'string' && field.convertible !== false)) {
          return ValidateResult.err(field.fail_message ?? `The \`${key}\` field should be of type \`${field.type}\`.`);
        }
        let val: number;
        // Conversion
        if (typeof target === 'string') {
          const converted = parseInt(target);
          if (isNaN(converted))
            return ValidateResult.err(field.fail_message ?? `Unable to convert field \`${key}\` to a number.`);
          val = converted;
        } else if (typeof target === 'number') val = target;
        // Check range
        if (field.min !== undefined) {
          if (val! < field.min)
            return ValidateResult.err(field.fail_message ?? `The \`${key}\` field should be larger than ${field.min}.`);
        }
        if (field.max !== undefined) {
          if (val! > field.max)
            return ValidateResult.err(
              field.fail_message ?? `The \`${key}\` field should be smaller than ${field.max}.`
            );
        }
        result[key] = val!;
        break;
      }

      case 'boolean': {
        if (
          typeof target !== 'boolean' &&
          !(typeof target === 'string' && field.convertible !== false) &&
          !(typeof target === 'number' && field.convertible !== false)
        ) {
          return ValidateResult.err(field.fail_message ?? `The \`${key}\` field should be of type \`${field.type}\`.`);
        }
        // Conversion
        let val: boolean | undefined;
        if (typeof target === 'string') {
          if (['true', 'yes', 'y', '1'].includes(target.toLowerCase())) val = true;
          else if (['false', 'no', 'n', '0'].includes(target.toLowerCase())) val = false;
        } else if (typeof target === 'number') {
          if (target === 1) val = true;
          else if (target === 0) val = false;
        } else val = target;

        if (val === undefined)
          return ValidateResult.err(field.fail_message ?? `Unable to convert field \`${key}\` to a boolean.`);
        result[key] = val;
        break;
      }

      case 'string':
        if (typeof target !== 'string')
          return ValidateResult.err(field.fail_message ?? `The \`${key}\` field should be of type \`${field.type}\`.`);
        // Check range
        if (field.min !== undefined) {
          if (target.length < field.min)
            return ValidateResult.err(
              field.fail_message ?? `The \`${key}\` field should have at least ${field.min} characters.`
            );
        }
        if (field.max !== undefined) {
          if (target.length > field.max)
            return ValidateResult.err(
              field.fail_message ?? `The \`${key}\` field should have no more than ${field.max} characters.`
            );
        }
        break;

      default:
        if (typeof target !== field.type)
          return ValidateResult.err(field.fail_message ?? `The \`${key}\` field should be of type \`${field.type}\`.`);
    }
  }
  return ValidateResult.ok(result);
}
