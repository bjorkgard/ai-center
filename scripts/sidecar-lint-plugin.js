// Local oxlint plugin: oxlint has no `no-restricted-syntax`, so sidecar/ rules live here.
// sidecar/server.ts must load as ESM (Vite plugin) and as CJS (SEA bundle).
const FUNCTIONS = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"];

const noImportMeta = {
  meta: { type: "problem" },
  create(context) {
    return {
      MetaProperty(node) {
        context.report({
          node,
          message: "No import.meta in sidecar/: it must load as ESM and as the CJS SEA bundle.",
        });
      },
    };
  },
};

const noTopLevelAwait = {
  meta: { type: "problem" },
  create(context) {
    let depth = 0;
    const visitor = {
      AwaitExpression(node) {
        if (depth === 0) context.report({ node, message: "No top-level await in sidecar/." });
      },
      ForOfStatement(node) {
        if (depth === 0 && node.await)
          context.report({ node, message: "No top-level await in sidecar/." });
      },
    };
    for (const type of FUNCTIONS) {
      visitor[type] = () => {
        depth++;
      };
      visitor[`${type}:exit`] = () => {
        depth--;
      };
    }
    return visitor;
  },
};

export default {
  meta: { name: "sidecar" },
  rules: { "no-import-meta": noImportMeta, "no-top-level-await": noTopLevelAwait },
};
