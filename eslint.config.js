import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "schemas/**",
      "**/fixtures/**",
      "scripts/evals/suites/*/hidden/**",
      ".superpowers/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.{1,2}/.*\\.(js|ts|mjs|cjs)$",
              message: "Use extensionless relative imports (moduleResolution: Bundler).",
            },
          ],
        },
      ],
    },
  },
  {
    // Documentation is enforced on published source only; tests and scripts are exempt.
    files: ["packages/*/src/**/*.ts", "adapters/*/src/**/*.ts"],
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ClassDeclaration: true,
            MethodDefinition: true,
            ArrowFunctionExpression: true,
            FunctionExpression: false,
          },
          contexts: [
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "ExportNamedDeclaration > VariableDeclaration",
          ],
        },
      ],
      "jsdoc/require-description": "error",
    },
  },
);
