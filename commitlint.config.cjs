/**
 * Commitlint（索引仓库根模板唯一真源；本包 scope 按 src 模块追加：templates。
 * 通用规则改模板再同步，不私改。）
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 160],
    "scope-enum": [2, "always", ["cordis", "client", "tests", "infra", "deps", "templates"]],
    "scope-case": [2, "always", "lower-case"],
    // 中文 subject 常见，且允许 AI/API/SRC/GUI 等缩写开头：关掉大小写启发式。
    "subject-case": [0],
  },
};
