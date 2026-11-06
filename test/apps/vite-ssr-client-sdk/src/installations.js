// A page module that imports a Firebase subpath the plugin doesn't serve.
import { getInstallations } from "firebase/installations";

export const installationsOf = getInstallations;
