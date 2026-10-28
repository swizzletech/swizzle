/**
 * The length an account password must have. The API refuses any other, and the dashboard's
 * password forms say so before they send one.
 */
export const PASSWORD_LENGTH = { max: 128, min: 15 } as const;
