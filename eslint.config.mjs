import js from "@eslint/js";
import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import jsdoc from "eslint-plugin-jsdoc";
import tsdoc from "eslint-plugin-tsdoc";

const sourceFiles = ["src/**/*.ts"];

export default [
    {
        ignores: [
            "out/**",
            "dist/**",
            "node_modules/**",
        ],
    },
    { ...js.configs.recommended, files: sourceFiles },
    ...typescriptEslint.configs["flat/recommended"].map((config) => ({ ...config, files: sourceFiles })),
    {
        files: sourceFiles,
        languageOptions: {
            parser: tsParser,
            ecmaVersion: 2022,
            sourceType: "module",
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },

        rules: {
            "@typescript-eslint/naming-convention": [
                "warn",
                {
                    selector: "import",
                    format: [
                        "camelCase",
                        "PascalCase",
                    ],
                },
            ],

            // SDK payloads still use dynamic types; tightening them is a separate migration.
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
            ],
            "@typescript-eslint/no-floating-promises": [
                "error",
                { checkThenables: true },
            ],
            "@typescript-eslint/no-misused-promises": "error",
            // Timer and cancellation callbacks capture handles before their assignment.
            "prefer-const": [
                "error",
                { ignoreReadBeforeAssign: true },
            ],
            curly: "error",
            eqeqeq: "error",
            "no-throw-literal": "error",
            // AGENTS.md: an ignored rejection needs a reason, given in the disable comment.
            "no-restricted-syntax": [
                "error",
                {
                    selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression.arguments[body.type='BlockStatement'][body.body.length=0]",
                    message: "Log the failure, or disable this rule with a comment saying why ignoring it is safe.",
                },
            ],
        },
    },
    // AGENTS.md: exported declarations have a TSDoc comment (what it does and why); tsdoc/syntax keeps the comments valid TSDoc.
    {
        files: sourceFiles,
        plugins: { jsdoc, tsdoc },
        rules: {
            "jsdoc/require-jsdoc": [
                "error",
                {
                    publicOnly: true,
                    require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true },
                    checkConstructors: false,
                    contexts: [
                        "TSInterfaceDeclaration",
                        "TSTypeAliasDeclaration",
                        "ExportNamedDeclaration > VariableDeclaration",
                    ],
                },
            ],
            "tsdoc/syntax": "error",
        },
    },
    eslintConfigPrettier,
];
