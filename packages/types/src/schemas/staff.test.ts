import { describe, expect, it } from 'vitest';
import { StaffRole } from '../codes/staff-role';
import { createStaffSchema, missingLicenceField } from './staff';

/**
 * A driver needs BOTH halves of a licence on file: the number and the expiry.
 *
 * The expiry became required after a driver with a number and no expiry saved
 * cleanly on the staff screen and was then refused at the moment somebody put
 * them in a driver slot. The record looked complete, the refusal arrived a
 * screen away and a day later, and the message on the way in had said nothing.
 *
 * No database here — this is a pure cross-field rule, and the point of testing
 * it at this level is that both callers (`createStaffSchema` and the update
 * path in `staff.service.ts`) go through the same function.
 */

const base = {
  firstName: 'Ricardo',
  lastName: 'Dela Cruz',
  phone: null,
  email: null,
  address: null,
  dateHired: null,
  isActive: true,
};

const driver = (licence: { licenseNumber: string | null; licenseExpiry: string | null }) => ({
  ...base,
  eligibleRoles: [StaffRole.DRIVER],
  ...licence,
});

const COMPLETE = { licenseNumber: 'N01-23-456789', licenseExpiry: '2028-04-30T00:00:00.000Z' };

describe('which half of the licence is missing', () => {
  it('names the number when there is none', () => {
    expect(missingLicenceField(driver({ licenseNumber: null, licenseExpiry: null }))).toBe(
      'licenseNumber',
    );
  });

  /**
   * THE CASE THAT PROMPTED THIS. Naming `licenseNumber` here — as the old
   * boolean rule's fixed path did — sends somebody to look at a value that is
   * already correct.
   */
  it('names the expiry when the number is present and the expiry is not', () => {
    expect(
      missingLicenceField(driver({ licenseNumber: 'N01-23-456789', licenseExpiry: null })),
    ).toBe('licenseExpiry');
  });

  it('is satisfied by both', () => {
    expect(missingLicenceField(driver(COMPLETE))).toBeNull();
  });

  /**
   * The rule is about the DRIVER role, not about tidiness. A helper with no
   * licence is an ordinary employee, and a dispatch manager holds cash without
   * driving — demanding a licence from either would refuse a real person.
   */
  it('asks nothing of a helper', () => {
    expect(
      missingLicenceField({
        ...base,
        eligibleRoles: [StaffRole.HELPER],
        licenseNumber: null,
        licenseExpiry: null,
      }),
    ).toBeNull();
  });

  it('asks nothing of a dispatch manager', () => {
    expect(
      missingLicenceField({
        ...base,
        eligibleRoles: [StaffRole.DISPATCH_MANAGER],
        licenseNumber: null,
        licenseExpiry: null,
      }),
    ).toBeNull();
  });

  it('asks for both from somebody eligible for driving AND helping', () => {
    expect(
      missingLicenceField({
        ...base,
        eligibleRoles: [StaffRole.DRIVER, StaffRole.HELPER],
        licenseNumber: null,
        licenseExpiry: null,
      }),
    ).toBe('licenseNumber');
  });

  /**
   * An expired licence is a FACT, and the office wants it recorded. Refusing it
   * here would leave nowhere to say "this lapsed in March"; the driver slot is
   * what declines to dispatch against one.
   */
  it('accepts a licence that has already expired', () => {
    expect(
      missingLicenceField(
        driver({ licenseNumber: 'N01-23-456789', licenseExpiry: '2001-01-01T00:00:00.000Z' }),
      ),
    ).toBeNull();
  });
});

describe('the create schema puts the issue on the missing field', () => {
  const parse = (value: unknown) => createStaffSchema.safeParse(value);

  it('rejects a driver with no expiry, and points at the expiry', () => {
    const result = parse(driver({ licenseNumber: 'N01-23-456789', licenseExpiry: null }));

    expect(result.success).toBe(false);
    // The path is what the web form keys its inline error off, so a wrong one
    // highlights a field that is already filled in correctly.
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('licenseExpiry');
  });

  it('rejects a driver with no number, and points at the number', () => {
    const result = parse(driver({ licenseNumber: null, licenseExpiry: null }));

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('licenseNumber');
  });

  it('accepts a complete driver', () => {
    expect(parse(driver(COMPLETE)).success).toBe(true);
  });

  it('accepts a helper with nothing on file', () => {
    expect(
      parse({
        ...base,
        eligibleRoles: [StaffRole.HELPER],
        licenseNumber: null,
        licenseExpiry: null,
      }).success,
    ).toBe(true);
  });
});
