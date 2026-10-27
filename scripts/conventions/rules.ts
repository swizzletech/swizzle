import type { Rule } from "./lint.js";
import { ciRunsJustRecipes } from "./rules/ci-runs-just-recipes.js";
import { docLinks } from "./rules/doc-links.js";
import { docsRunJustRecipes } from "./rules/docs-run-just-recipes.js";
import { envExampleReachesCompose } from "./rules/env-example-reaches-compose.js";
import { lockfileFrozen } from "./rules/lockfile-frozen.js";
import { noCoverageGate } from "./rules/no-coverage-gate.js";
import { noEnvExampleCopy } from "./rules/no-env-example-copy.js";
import { noOtherProducts } from "./rules/no-other-products.js";
import { noPrivatePaths } from "./rules/no-private-paths.js";
import { noRootPackageScripts } from "./rules/no-root-package-scripts.js";
import { platformVersion } from "./rules/platform-version.js";
import { recipesSayWhy } from "./rules/recipes-say-why.js";
import { reviewConfigPaths } from "./rules/review-config-paths.js";
import { sdkCopiesMatch } from "./rules/sdk-copies-match.js";
import { skillTeachesTheProduct } from "./rules/skill-teaches-the-product.js";
import { toolchainPins } from "./rules/toolchain-pins.js";
import { webReadsTheContract } from "./rules/web-reads-the-contract.js";

/** Public repository rules. conventions.test.ts exercises each registered rule. */
export const rules: readonly Rule[] = [
  docLinks,
  toolchainPins,
  platformVersion,
  noEnvExampleCopy,
  envExampleReachesCompose,
  docsRunJustRecipes,
  noCoverageGate,
  skillTeachesTheProduct,
  ciRunsJustRecipes,
  noRootPackageScripts,
  lockfileFrozen,
  recipesSayWhy,
  sdkCopiesMatch,
  noOtherProducts,
  noPrivatePaths,
  reviewConfigPaths,
  webReadsTheContract,
];
