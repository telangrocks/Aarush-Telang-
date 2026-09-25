import { describe, it, expect } from 'vitest';
import { isValidPassword } from './user';

describe("Password Validation Parity Tests (10-Case Matrix)", () => {
  it("Case 1: Valid standard ASCII password", () => {
    expect(isValidPassword("Pass1234@")).toBe(true);
  });

  it("Case 2: Invalid first character", () => {
    expect(isValidPassword("#Pass1234@")).toBe(false);
  });

  it("Case 3: Missing lowercase letter", () => {
    expect(isValidPassword("PASS1234@")).toBe(false);
  });

  it("Case 4: Missing uppercase letter", () => {
    expect(isValidPassword("pass1234@")).toBe(false);
  });

  it("Case 5: Missing digit", () => {
    expect(isValidPassword("PassWord@@")).toBe(false);
  });

  it("Case 6: Missing required symbol (@$!%*?&)", () => {
    expect(isValidPassword("Pass12345")).toBe(false);
  });

  it("Case 7: Less than 8 characters", () => {
    expect(isValidPassword("Pass1@")).toBe(false);
  });

  it("Case 8: Unicode character after 1st char", () => {
    expect(isValidPassword("Pass1234@é")).toBe(true);
  });

  it("Case 9: Space after 1st char", () => {
    expect(isValidPassword("Pass 1234@")).toBe(true);
  });

  it("Case 10: Dash or underscore after 1st char", () => {
    expect(isValidPassword("Pass-1234_@")).toBe(true);
  });
});
