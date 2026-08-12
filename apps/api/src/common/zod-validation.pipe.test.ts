import { BadRequestException } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createZodDto } from './create-zod-dto';
import { ZodValidationPipe } from './zod-validation.pipe';

const bodyMetadata = (metatype: unknown): ArgumentMetadata =>
  ({ type: 'body', metatype, data: undefined }) as ArgumentMetadata;

class SampleDto extends createZodDto(
  z.object({
    origin: z.string().min(1),
    grossRate: z.string().regex(/^\d+(\.\d{1,4})?$/),
  }),
) {}

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe();

  it('accepts and returns valid input', () => {
    const result = pipe.transform(
      { origin: 'Manila', grossRate: '18000.00' },
      bodyMetadata(SampleDto),
    );

    expect(result).toEqual({ origin: 'Manila', grossRate: '18000.00' });
  });

  it('strips fields the schema does not declare', () => {
    // The audit columns are system-owned. Even if a client sends them, they
    // must never survive the pipe and reach a service.
    const result = pipe.transform(
      {
        origin: 'Manila',
        grossRate: '18000.00',
        createdBy: 'attacker-user-id',
        updatedBy: 'attacker-user-id',
        driverCommission: '999999.00',
      },
      bodyMetadata(SampleDto),
    );

    expect(result).toEqual({ origin: 'Manila', grossRate: '18000.00' });
    expect(result).not.toHaveProperty('createdBy');
    expect(result).not.toHaveProperty('updatedBy');
    expect(result).not.toHaveProperty('driverCommission');
  });

  it('rejects invalid input with a 400 listing every issue', () => {
    expect(() =>
      pipe.transform({ origin: '', grossRate: 'not-a-number' }, bodyMetadata(SampleDto)),
    ).toThrow(BadRequestException);

    try {
      pipe.transform({ origin: '', grossRate: 'not-a-number' }, bodyMetadata(SampleDto));
    } catch (error) {
      const response = (error as BadRequestException).getResponse() as {
        message: string;
        errors: { path: string }[];
      };
      expect(response.message).toBe('Validation failed');
      expect(response.errors.map((issue) => issue.path).sort()).toEqual(['grossRate', 'origin']);
    }
  });

  it('passes through parameters that are not Zod DTOs', () => {
    const value = { anything: true };
    expect(pipe.transform(value, bodyMetadata(Object))).toBe(value);
    expect(pipe.transform('raw-id', bodyMetadata(String))).toBe('raw-id');
  });
});
