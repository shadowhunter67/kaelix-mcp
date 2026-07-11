// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "eslint.config.js"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Prettier owns formatting; keep lint focused on correctness/safety.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    files: ["test/**/*.js", "test/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: false, project: false },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
);
