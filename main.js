"use strict";

/*
 * Created with @iobroker/create-adapter v2.3.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;

const Json2iob = require("json2iob");

// Load your modules here, e.g.:
// const fs = require("fs");

class Homenet extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: "homenet",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.deviceArray = [];

    this.json2iob = new Json2iob(this);

    this.requestClient = axios.create({
      headers: {
        accept: "*/*",
        "wp-client-appname": "BAUKNECHT",
        "wp-client-platform": "IOS",
        "wp-client-region": "EMEA",
        "accept-language": "de-DE;q=1.0",
        "wp-client-country": "DE",
        "wp-client-language": "ger",
        "application-brand": "BAUKNECHT",
        "user-agent": "BKT - Store/7.0.4 (com.bauknecht.blive; build:1; iOS 15.8.3) Alamofire/5.9.1",
        "wp-client-brand": "BAUKNECHT",
      },
    });
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState("info.connection", false, true);
    if (this.config.interval < 0.5) {
      this.log.info("Set interval to minimum 0.5");
      this.config.interval = 0.5;
    }
    if (!this.config.username || !this.config.password) {
      this.log.error("Please set username and password in the instance settings");
      return;
    }

    this.updateInterval = null;
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
    this.subscribeStates("*");

    this.log.info("Login to Home Net");
    await this.login();
    if (this.session.access_token) {
      await this.getDeviceList();
      await this.updateDevices();
      this.updateInterval = setInterval(async () => {
        await this.updateDevices();
      }, this.config.interval * 60 * 1000);
      const expires = this.session.expires_in - 100 || 3500;
      this.refreshTokenInterval = setInterval(() => {
        this.refreshToken();
      }, expires * 1000);
    }
  }
  async login() {
    const loginSession = await this.requestClient({
      method: "post",
      maxBodyLength: Infinity,
      url: "https://prod-api.whrcloud.eu/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      data: {
        client_id: "bauknecht_emea_ios_v1",
        client_secret: "ULGPmG6ovWSe-5kEkPXNmvA20XpiC2zbVY9Qov941pDAT4mCaZoV-O_esMCiZ07R",
        grant_type: "client_credentials",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        return res.data;
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });

    await this.requestClient({
      method: "post",
      url: "https://prod-api.whrcloud.eu/oauth/token",
      headers: {
        Authorization: "Bearer " + loginSession.access_token,
        "Content-Type": "application/x-www-form-urlencoded",
        Connection: "keep-alive",
      },
      data: {
        client_id: "bauknecht_emea_ios_v1",
        client_secret: "ULGPmG6ovWSe-5kEkPXNmvA20XpiC2zbVY9Qov941pDAT4mCaZoV-O_esMCiZ07R",
        grant_type: "password",
        password: this.config.password,
        username: this.config.username,
        "wp-client-brand": "BAUKNECHT",
        "wp-client-region": "EMEA",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.setState("info.connection", true, true);
        this.session = res.data;
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceList() {
    await this.requestClient({
      method: "get",
      url: "https://prod-api.whrcloud.eu/api/v3/appliance/all/account/" + this.session.accountId,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + this.session.access_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        //this.log.info(`Found ${res.data} devices`);
        const locationsObject = res.data[this.session.accountId];
        for (const location in locationsObject) {
          const locationObject = locationsObject[location];
          const tsAppliance = locationObject.tsAppliance;
          const legacyAppliance = locationObject.legacyAppliance;
          this.log.info(
            `Found ${tsAppliance.length} devices and ${legacyAppliance.length} legacy devices in location ${location}`,
          );
          const mergedAppliance = tsAppliance.concat(legacyAppliance);

          for (const device of mergedAppliance) {
            const id = device.SAID;

            this.deviceArray.push(id);
            const name = device.APPLIANCE_NAME + " " + device.CATEGORY_NAME;

            await this.extendObject(id, {
              type: "device",
              common: {
                name: name,
              },
              native: {},
            });
            await this.extendObject(id + ".remote", {
              type: "channel",
              common: {
                name: "Remote Controls",
              },
              native: {},
            });

            const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
            remoteArray.forEach((remote) => {
              this.extendObject(id + ".remote." + remote.command, {
                type: "state",
                common: {
                  name: remote.name || "",
                  type: remote.type || "boolean",
                  role: remote.role || "boolean",
                  def: remote.def == null ? false : remote.def,
                  write: true,
                  read: true,
                },
                native: {},
              });
            });
            await this.extendObject(id + ".general", {
              type: "channel",
              common: {
                name: "General Information",
              },
              native: {},
            });
            this.json2iob.parse(id + ".general", device, { forceIndex: true });
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async updateDevices() {
    const statusArray = [
      {
        path: "status",
        url: "https://prod-api.whrcloud.eu/api/v1/appliance/$id",
        desc: "Status of the device",
      },
    ];
    for (const id of this.deviceArray) {
      for (const element of statusArray) {
        const url = element.url.replace("$id", id);

        await this.requestClient({
          method: element.method || "get",
          url: url,
          headers: {
            Host: "prod-api.whrcloud.eu",
            "content-type": "application/json",
            authorization: "Bearer " + this.session.access_token,
          },
        })
          .then(async (res) => {
            this.log.debug(JSON.stringify(res.data));
            if (!res.data) {
              return;
            }
            const data = res.data;

            const forceIndex = true;
            const preferedArrayName = null;

            this.json2iob.parse(id + "." + element.path, data, {
              forceIndex: forceIndex,
              write: true,
              preferedArrayName: preferedArrayName,
              channelName: element.desc,
            });
            // await this.setObjectNotExistsAsync(element.path + ".json", {
            //   type: "state",
            //   common: {
            //     name: "Raw JSON",
            //     write: false,
            //     read: true,
            //     type: "string",
            //     role: "json",
            //   },
            //   native: {},
            // });
            // this.setState(element.path + ".json", JSON.stringify(data), true);
          })
          .catch((error) => {
            if (error.response) {
              if (error.response.status === 401) {
                error.response && this.log.debug(JSON.stringify(error.response.data));
                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                this.refreshTokenTimeout = setTimeout(() => {
                  this.refreshToken();
                }, 1000 * 60);

                return;
              }
            }
            this.log.error(element.url);
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      }
    }
  }

  async refreshToken() {
    this.log.debug("Refresh token");

    await this.requestClient({
      method: "post",
      url: "https://prod-api.whrcloud.eu/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },

      data: {
        client_id: "bauknecht_emea_ios_v1",
        client_secret: "ULGPmG6ovWSe-5kEkPXNmvA20XpiC2zbVY9Qov941pDAT4mCaZoV-O_esMCiZ07R",
        grant_type: "refresh_token",
        refresh_token: this.session.refresh_token,
        "wp-client-brand": "BAUKNECHT",
        "wp-client-region": "EMEA",
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.log.debug("Refresh successful");
        this.setState("info.connection", true, true);
      })
      .catch(async (error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
        this.setState("info.connection", false, true);
      });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState("info.connection", false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
      callback();
    } catch (e) {
      this.log.error(e);
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split(".")[2];
        const command = id.split(".")[5];

        if (id.split(".")[4] === "Refresh") {
          this.updateDevices();
          return;
        }
        const data = {
          body: {},
          header: {
            command: "setAttributes",
            said: deviceId,
          },
        };
        data.body[command] = state.val;
        await this.requestClient({
          method: "post",
          url: "https://prod-api.whrcloud.eu/api/v1/appliance/command",
          headers: {
            Host: "prod-api.whrcloud.eu",
            "content-type": "application/json",
            authorization: "Bearer " + this.session.access_token,
            accept: "*/*",
          },
          data: JSON.stringify(data),
        })
          .then((res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch(async (error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout = setTimeout(async () => {
          this.log.info("Update devices");
          await this.updateDevices();
        }, 10 * 1000);
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Homenet(options);
} else {
  // otherwise start the instance directly
  new Homenet();
}
