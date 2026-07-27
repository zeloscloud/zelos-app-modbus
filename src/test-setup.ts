import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// RTL's auto-cleanup hooks into Jest globals; vitest doesn't expose them by
// default. Register manually so each test starts with an empty DOM and
// `getByText` doesn't trip over leftover renders from prior cases.
afterEach(() => {
  cleanup();
});
