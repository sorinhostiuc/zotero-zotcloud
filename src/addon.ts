import { config } from "../package.json";

class Addon {
  public data = {
    alive: true,
    config: {
      addonID: config.addonID,
      addonRef: config.addonRef,
      addonName: config.addonName,
      addonInstance: config.addonInstance,
    },
  };
}

export default Addon;
