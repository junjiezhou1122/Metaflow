import { defineViewPackage } from "@info/view-package";
import { personalActivityManifest } from "./contracts.js";

export * from "./contracts.js";
export * from "./transformations.js";

export const personalActivityViewPackage = defineViewPackage(personalActivityManifest);
