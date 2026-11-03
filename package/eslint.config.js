import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-test/**",
      "**/coverage/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 程序间隔离：apps/<x>/ 之间禁止相互 import——共享代码只能下沉到 packages/
    // （../../packages/... 以 "../.." 开头，不受本规则影响；程序保持单文件薄壳，
    // 更深的文件跨程序引用需自行遵守同一纪律）
    files: ["apps/*/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./(?!\\.)",
              message:
                "程序之间禁止相互依赖：共享代码请下沉到 packages/（../../packages/...）",
            },
          ],
        },
      ],
    },
  },
);
