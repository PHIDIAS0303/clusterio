"use strict";
const fs = require("fs-extra");
const path = require("path");
const pidusage = require("pidusage");
const phin = require("phin");
const util = require("util");

// internal libraries
const libFileOps = require("@clusterio/lib/file_ops");
const libFactorio = require("@clusterio/lib/factorio");
const libLink = require("@clusterio/lib/link");
const libPlugin = require("@clusterio/lib/plugin");
const libPluginLoader = require("@clusterio/lib/plugin_loader");
const libErrors = require("@clusterio/lib/errors");
const libPrometheus = require("@clusterio/lib/prometheus");
const libLuaTools = require("@clusterio/lib/lua_tools");
const { logger } = require("@clusterio/lib/logging");


const instanceRconCommandDuration = new libPrometheus.Histogram(
	"clusterio_instance_rcon_command_duration_seconds",
	"Histogram of the RCON command duration from request to response.",
	{ labels: ["instance_id"] }
);

const instanceRconCommandSize = new libPrometheus.Histogram(
	"clusterio_instance_rcon_command_size_bytes",
	"Histogram of the RCON command sizes that are sent.",
	{
		labels: ["instance_id", "plugin"],
		buckets: libPrometheus.Histogram.exponential(16, 2, 12),
	}
);

const instanceFactorioCpuTime = new libPrometheus.Gauge(
	"clusterio_instance_factorio_cpu_time_total",
	"Factorio CPU time spent in seconds.",
	{ labels: ["instance_id"] }
);

const instanceFactorioMemoryUsage = new libPrometheus.Gauge(
	"clusterio_instance_factorio_resident_memory_bytes",
	"Factorio resident memory size in bytes.",
	{ labels: ["instance_id"] }
);

const instanceFactorioAutosaveSize = new libPrometheus.Gauge(
	"clusterio_instance_factorio_autosave_bytes",
	"Size of Factorio server autosave in bytes.",
	{ labels: ["instance_id"] }
);

function applyAsConfig(name) {
	return async function action(instance, value) {
		if (name === "tags" && value instanceof Array) {
			// Replace spaces with non-break spaces and delimit by spaces.
			// This does change the defined tags, but there doesn't seem to
			// be a way to include a space into a tag from the console.
			value = value.map(tag => tag.replace(/ /g, "\u00a0")).join(" ");
		}
		try {
			await instance.sendRcon(`/config set ${name} ${value}`);
		} catch (err) {
			logger.error(`Error applying server setting ${name} ${err.message}`);
		}
	};
}

const serverSettingsActions = {
	"afk_autokick_interval": applyAsConfig("afk-auto-kick"),
	"allow_commands": applyAsConfig("allow-commands"),
	"autosave_interval": applyAsConfig("autosave-interval"),
	"autosave_only_on_server": applyAsConfig("autosave-only-on-server"),
	"description": applyAsConfig("description"),
	"ignore_player_limit_for_returning_players": applyAsConfig("ignore-player-limit-for-returning-players"),
	"max_players": applyAsConfig("max-players"),
	"max_upload_slots": applyAsConfig("max-upload-slots"),
	"max_upload_in_kilobytes_per_second": applyAsConfig("max-upload-speed"),
	"name": applyAsConfig("name"),
	"only_admins_can_pause_the_game": applyAsConfig("only-admins-can-pause"),
	"game_password": applyAsConfig("password"),
	"require_user_verification": applyAsConfig("require-user-verification"),
	"tags": applyAsConfig("tags"),
	"visibility": async (instance, value) => {
		for (let scope of ["lan", "public", "steam"]) {
			try {
				let enabled = Boolean(value[scope]);
				await instance.sendRcon(`/config set visibility-${scope} ${enabled}`);
			} catch (err) {
				logger.error(`Error applying visibility ${scope} ${err}`);
			}
		}
	},
};

/**
 * Create and update symlinks for shared mods in an instance
 *
 * Creates symlinks for .zip and .dat files that are not present in the
 * instance mods directory but is present in the sharedMods directory,
 * and removes any symlinks that don't point to a file in the instance
 * mods directory.  If the instance mods directory doesn't exist it will
 * be created.
 *
 * Note that on Windows this creates hard links instead of symbolic
 * links as the latter requires elevated privileges.  This unfortunately
 * means the removal of mods from the shared mods dir can't be detected.
 *
 * @param {Instance} instance - Instance to link mods for
 * @param {string} sharedMods - Path to folder to link mods from.
 * @private
 */
async function symlinkMods(instance, sharedMods) {
	await fs.ensureDir(instance.path("mods"));

	// Remove broken symlinks in instance mods.
	for (let entry of await fs.readdir(instance.path("mods"), { withFileTypes: true })) {
		if (entry.isSymbolicLink()) {
			if (!await fs.pathExists(instance.path("mods", entry.name))) {
				instance.logger.verbose(`Removing broken symlink ${entry.name}`);
				await fs.unlink(instance.path("mods", entry.name));
			}
		}
	}

	// Link entries that are in sharedMods but not in instance mods.
	let instanceModsEntries = new Set(await fs.readdir(instance.path("mods")));
	for (let entry of await fs.readdir(sharedMods, { withFileTypes: true })) {
		if (entry.isFile()) {
			if ([".zip", ".dat", ".json"].includes(path.extname(entry.name))) {
				if (!instanceModsEntries.has(entry.name)) {
					instance.logger.verbose(`linking ${entry.name} from ${sharedMods}`);
					let target = path.join(sharedMods, entry.name);
					let link = instance.path("mods", entry.name);

					/* eslint-disable max-depth */
					if (process.platform !== "win32") {
						await fs.symlink(path.relative(path.dirname(link), target), link);

					// On Windows symlinks require elevated privileges, which is
					// not something we want to have.  For this reason the mods
					// are hard linked instead.  This has the drawback of not
					// being able to identify when mods are removed from the
					// sharedMods directory, or which mods are linked.
					} else {
						await fs.link(target, link);
					}
					/* eslint-enable max-depth */
				}

			} else {
				instance.logger.warn(`Warning: ignoring file '${entry.name}' in sharedMods`);
			}

		} else {
			instance.logger.warn(`Warning: ignoring non-file '${entry.name}' in sharedMods`);
		}
	}
}


/**
 * Keeps track of the runtime parameters of an instance
 * @alias module:slave/src/Instance
 */
class Instance extends libLink.Link {
	constructor(slave, connector, dir, factorioDir, instanceConfig) {
		super("instance", "slave", connector);
		libLink.attachAllMessages(this);
		this._slave = slave;
		this._dir = dir;

		this.plugins = new Map();
		this.config = instanceConfig;

		/**
		 * ID of this instance, equivalenet to `instance.config.get("instance.id")`.
		 * @constant {number}
		 */
		this.id = this.config.get("instance.id");

		this.logger = logger.child({
			instance_id: this.id,
			instance_name: this.name,
		});

		this._configFieldChanged = (group, field, prev) => {
			let hook = () => libPlugin.invokeHook(this.plugins, "onInstanceConfigFieldChanged", group, field, prev);

			if (group.name === "factorio" && field === "settings") {
				this.updateFactorioSettings(group.get(field), prev).finally(hook);
			} else if (group.name === "factorio" && field === "enable_whitelist") {
				this.updateFactorioWhitelist(group.get(field)).finally(hook);
			} else {
				if (group.name === "factorio" && field === "max_concurrent_commands") {
					this.server.maxConcurrentCommands = group.get(field);
				}
				hook();
			}
		};
		this.config.on("fieldChanged", this._configFieldChanged);

		let serverOptions = {
			logger: this.logger,
			version: this.config.get("factorio.version"),
			gamePort: this.config.get("factorio.game_port"),
			rconPort: this.config.get("factorio.rcon_port"),
			rconPassword: this.config.get("factorio.rcon_password"),
			enableWhitelist: this.config.get("factorio.enable_whitelist"),
			enableAuthserverBans: this.config.get("factorio.enable_authserver_bans"),
			verboseLogging: this.config.get("factorio.verbose_logging"),
			stripPaths: this.config.get("factorio.strip_paths"),
			maxConcurrentCommands: this.config.get("factorio.max_concurrent_commands"),
		};

		// Valid statuses are stopped, starting, running, stopping, creating_save and exporting_data.
		this._status = "stopped";
		this._loadedSave = null;
		this.server = new libFactorio.FactorioServer(
			factorioDir, this._dir, serverOptions
		);

		this.server.on("output", (parsed, line) => {
			this.logger.log("server", { message: line, instance_id: this.id, parsed });

			libPlugin.invokeHook(this.plugins, "onOutput", parsed, line);
		});

		this.server.on("error", err => {
			if (err instanceof libErrors.EnvironmentError) {
				this.logger.error(err.message);
			} else {
				this.logger.error(`${this.name}:\n${err.stack}`);
			}
		});

		this.server.on("autosave-finished", name => {
			this._autosave(name).catch(err => {
				this.logger.error(`Error handling autosave-finished in instance ${this.name}:\n${err.stack}`);
			});
		});

		this.server.on("save-finished", () => {
			this.sendSaveListUpdate().catch(err => {
				this.logger.error(`Error handling save-finished in instance ${this.name}:\n${err.stack}`);
			});
		});

		this.server.on("ipc-player_event", event => {
			libLink.messages.playerEvent.send(this, {
				instance_id: this.id,
				...event,
			});
			libPlugin.invokeHook(this.plugins, "onPlayerEvent", event);
		});
	}

	async sendRcon(message, expectEmpty, plugin = "") {
		let instanceId = String(this.id);
		let observeDuration = instanceRconCommandDuration.labels(instanceId).startTimer();
		try {
			return await this.server.sendRcon(message, expectEmpty);
		} finally {
			observeDuration();
			instanceRconCommandSize.labels(instanceId, plugin).observe(Buffer.byteLength(message, "utf8"));
		}
	}

	static async listSaves(savesDir, loadedSave) {
		let defaultSave = null;
		if (loadedSave === null) {
			defaultSave = await libFileOps.getNewestFile(
				savesDir, (name) => !name.endsWith(".tmp.zip")
			);
		}

		let list = [];
		for (let name of await fs.readdir(savesDir)) {
			let type;
			let stat = await fs.stat(path.join(savesDir, name));
			if (stat.isFile()) {
				type = "file";
			} else if (stat.isDirectory()) {
				type = "directory";
			} else {
				type = "special";
			}

			list.push({
				name,
				type,
				size: stat.size,
				mtime_ms: stat.mtimeMs,
				loaded: name === loadedSave,
				default: name === defaultSave,
			});
		}

		return list;
	}

	async sendSaveListUpdate() {
		libLink.messages.saveListUpdate.send(this, {
			instance_id: this.id,
			list: await Instance.listSaves(this.server.writePath("saves"), this._loadedSave),
		});
	}

	async _autosave(name) {
		let stat = await fs.stat(this.path("saves", `${name}.zip`));
		instanceFactorioAutosaveSize.labels(String(this.id)).set(stat.size);
		await this.sendSaveListUpdate();
	}

	notifyStatus(status) {
		this._status = status;
		libLink.messages.instanceStatusChanged.send(this, {
			instance_id: this.id,
			status,
			game_port: this.server && this.server.gamePort || this.config.get("factorio.game_port") || null,
		});
	}

	/**
	 * Current state of the instance
	 *
	 * One of stopped, starting, running, stopping, creating_save and exporting_data
	 *
	 * @returns {string} instance status.
	 */
	get status() {
		return this._status;
	}

	notifyExit() {
		this._loadedSave = null;
		this.notifyStatus("stopped");

		this.config.off("fieldChanged", this._configFieldChanged);

		// Clear metrics this instance is exporting
		for (let collector of libPrometheus.defaultRegistry.collectors) {
			if (
				collector instanceof libPrometheus.ValueCollector
				&& collector.metric.labels.includes("instance_id")
			) {
				collector.removeAll({ instance_id: String(this.id) });
			}
		}

		// Notify plugins of exit
		for (let pluginInstance of this.plugins.values()) {
			pluginInstance.onExit();
		}
	}

	async _loadPlugin(pluginInfo, slave) {
		let pluginLoadStarted = Date.now();
		let InstancePluginClass = await libPluginLoader.loadInstancePluginClass(pluginInfo);
		let instancePlugin = new InstancePluginClass(pluginInfo, this, slave);
		this.plugins.set(pluginInfo.name, instancePlugin);
		await instancePlugin.init();
		libPlugin.attachPluginMessages(this, instancePlugin);

		this.logger.info(`Loaded plugin ${pluginInfo.name} in ${Date.now() - pluginLoadStarted}ms`);
	}

	async init(pluginInfos) {
		this.notifyStatus("starting");
		try {
			await this.server.init();
		} catch (err) {
			this.notifyExit();
			await this.sendSaveListUpdate();
			throw err;
		}

		// load plugins
		for (let pluginInfo of pluginInfos) {
			if (
				!pluginInfo.instanceEntrypoint
				|| !this._slave.serverPlugins.has(pluginInfo.name)
				|| !this.config.group(pluginInfo.name).get("load_plugin")
			) {
				continue;
			}

			try {
				await this._loadPlugin(pluginInfo, this._slave);
			} catch (err) {
				this.notifyExit();
				await this.sendSaveListUpdate();
				throw err;
			}
		}

		let plugins = {};
		for (let [name, plugin] of this.plugins) {
			plugins[name] = plugin.info.version;
		}
		libLink.messages.instanceInitialized.send(this, { instance_id: this.id, plugins });
	}

	/**
	 * Resolve the effective Factorio server settings
	 *
	 * Use the example settings as the basis and override it with all the
	 * entries from the given settings object.
	 *
	 * @param {Object} overrides - Server settings to override.
	 * @returns {Object}
	 *     server example settings with the given settings applied over it.
	 */
	async resolveServerSettings(overrides) {
		let serverSettings = await this.server.exampleSettings();

		for (let [key, value] of Object.entries(overrides)) {
			if (!Object.hasOwnProperty.call(serverSettings, key)) {
				this.logger.warn(`Server settings does not have the property '${key}'`);
			}
			serverSettings[key] = value;
		}

		return serverSettings;
	}

	/**
	 * Write the server-settings.json file
	 *
	 * Generate the server-settings.json file from the example file in the
	 * data directory and override any settings configured in the instance's
	 * factorio_settings config entry.
	 */
	async writeServerSettings() {
		let serverSettings = await this.resolveServerSettings(this.config.get("factorio.settings"));
		await libFileOps.safeOutputFile(
			this.server.writePath("server-settings.json"),
			JSON.stringify(serverSettings, null, 4)
		);
	}

	/**
	 * Creates a new empty instance directory
	 *
	 * Creates the neccessary files for starting up a new instance into the
	 * provided instance directory.
	 *
	 * @param {String} instanceDir -
	 *     Directory to create the new instance into.
	 * @param {String} factorioDir - Path to factorio installation.
	 */
	static async create(instanceDir, factorioDir) {
		logger.info(`Creating ${instanceDir}`);
		await fs.ensureDir(path.join(instanceDir, "script-output"));
		await fs.ensureDir(path.join(instanceDir, "saves"));
	}

	/**
	 * Prepare instance for starting
	 *
	 * Writes server settings, admin/ban/white-lists and links mods.
	 */
	async prepare() {
		this.logger.verbose("Writing server-settings.json");
		await this.writeServerSettings();

		if (this.config.get("factorio.sync_adminlist")) {
			this.logger.verbose("Writing server-adminlist.json");
			libFileOps.safeOutputFile(
				this.server.writePath("server-adminlist.json"),
				JSON.stringify([...this._slave.adminlist], null, 4)
			);
		}

		if (this.config.get("factorio.sync_banlist")) {
			this.logger.verbose("Writing server-banlist.json");
			libFileOps.safeOutputFile(
				this.server.writePath("server-banlist.json"),
				JSON.stringify([...this._slave.banlist].map(
					([username, reason]) => ({ username, reason })
				), null, 4),
			);
		}

		if (this.config.get("factorio.sync_whitelist")) {
			this.logger.verbose("Writing server-whitelist.json");
			libFileOps.safeOutputFile(
				this.server.writePath("server-whitelist.json"),
				JSON.stringify([...this._slave.whitelist], null, 4)
			);
		}

		// eslint-disable-next-line no-use-before-define
		await symlinkMods(this, "sharedMods");
	}

	/**
	 * Prepare a save for starting
	 *
	 * Creates a new save if no save is passed and patches it with modules.
	 *
	 * @param {String|null} saveName -
	 *     Save to prepare from the instance saves directory.  Creates a new
	 *     save if null.
	 * @returns {String} Name of the save prepared.
	 */
	async prepareSave(saveName) {
		// Use latest save if no save was specified
		if (saveName === null) {
			saveName = await libFileOps.getNewestFile(
				this.path("saves"), (name) => !name.endsWith(".tmp.zip")
			);
		}

		// Create save if no save was found.
		if (saveName === null) {
			this.logger.info("Creating new save");
			await this.server.create("world.zip");
			saveName = "world.zip";
		}

		// Load a copy if it's autosave to prevent overwriting the autosave
		if (saveName.startsWith("_autosave")) {
			this.logger.info("Copying autosave");
			let now = new Date();
			let newName = util.format(
				"%s-%s-%s %s%s %s",
				now.getUTCFullYear(),
				(now.getUTCMonth() + 1).toLocaleString("en", { minimumIntegerDigits: 2 }),
				now.getUTCDate().toLocaleString("en", { minimumIntegerDigits: 2 }),
				now.getUTCHours().toLocaleString("en", { minimumIntegerDigits: 2 }),
				now.getUTCMinutes().toLocaleString("en", { minimumIntegerDigits: 2 }),
				saveName,
			);
			await fs.copy(this.path("saves", saveName), this.path("saves", newName));
			saveName = newName;
		}

		if (!this.config.get("factorio.enable_save_patching")) {
			return saveName;
		}

		// Patch save with lua modules from plugins
		this.logger.verbose("Patching save");

		// Find plugin modules to patch in
		let modules = new Map();
		for (let [pluginName, plugin] of this.plugins) {
			let pluginPackagePath = require.resolve(path.posix.join(plugin.info.requirePath, "package.json"));
			let modulePath = path.join(path.dirname(pluginPackagePath), "module");
			if (!await fs.pathExists(modulePath)) {
				continue;
			}

			let moduleJsonPath = path.join(modulePath, "module.json");
			if (!await fs.pathExists(moduleJsonPath)) {
				throw new Error(`Module for plugin ${pluginName} is missing module.json`);
			}

			let module = JSON.parse(await fs.readFile(moduleJsonPath));
			if (module.name !== pluginName) {
				throw new Error(`Expected name of module for plugin ${pluginName} to match the plugin name`);
			}

			module = {
				version: plugin.info.version,
				dependencies: { "clusterio": "*" },
				path: modulePath,
				load: [],
				require: [],
				...module,
			};
			modules.set(module.name, module);
		}

		// Find stand alone modules to load
		// XXX for now only the included clusterio module is loaded
		let modulesDirectory = path.join(__dirname, "..", "modules");
		for (let entry of await fs.readdir(modulesDirectory, { withFileTypes: true })) {
			if (!entry.isFile()) {
				if (modules.has(entry.name)) {
					throw new Error(`Module with name ${entry.name} already exists in a plugin`);
				}

				let moduleJsonPath = path.join(modulesDirectory, entry.name, "module.json");
				if (!await fs.pathExists(moduleJsonPath)) {
					throw new Error(`Module ${entry.name} is missing module.json`);
				}

				let module = JSON.parse(await fs.readFile(moduleJsonPath));
				if (module.name !== entry.name) {
					throw new Error(`Expected name of module ${entry.name} to match the directory name`);
				}

				module = {
					path: path.join(modulesDirectory, entry.name),
					dependencies: { "clusterio": "*" },
					load: [],
					require: [],
					...module,
				};
				modules.set(module.name, module);
			}
		}

		await libFactorio.patch(this.path("saves", saveName), [...modules.values()]);
		return saveName;
	}

	/**
	 * Start Factorio server
	 *
	 * Launches the Factorio server for this instance with the given save.
	 *
	 * @param {String} saveName - Name of save game to load.
	 */
	async start(saveName) {
		this.server.on("rcon-ready", () => {
			this.logger.verbose("RCON connection established");
		});

		this.server.on("exit", () => this.notifyExit());
		this._loadedSave = saveName;
		await this.server.start(saveName);

		if (this.config.get("factorio.enable_save_patching")) {
			await this.server.disableAchievements();
			await this.updateInstanceData();
		}

		await this.sendSaveListUpdate();
		await libPlugin.invokeHook(this.plugins, "onStart");

		this.notifyStatus("running");
	}

	/**
	 * Start Factorio server by loading a scenario
	 *
	 * Launches the Factorio server for this instance with the given
	 * scenario.
	 *
	 * @param {String} scenario - Name of scenario to load.
	 * @param {?number} seed - seed to use.
	 * @param {?object} mapGenSettings - MapGenSettings to use.
	 * @param {?object} mapSettings - MapSettings to use.
	 */
	async startScenario(scenario, seed, mapGenSettings, mapSettings) {
		this.server.on("rcon-ready", () => {
			this.logger.verbose("RCON connection established");
		});

		this.server.on("exit", () => this.notifyExit());
		await this.server.startScenario(scenario, seed, mapGenSettings, mapSettings);

		await libPlugin.invokeHook(this.plugins, "onStart");

		this.notifyStatus("running");
	}

	/**
	 * Update instance information on the Factorio side
	 */
	async updateInstanceData() {
		let name = libLuaTools.escapeString(this.name);
		await this.sendRcon(`/sc clusterio_private.update_instance(${this.id}, "${name}")`, true);
	}

	async updateFactorioSettings(current, previous) {
		current = await this.resolveServerSettings(current);
		previous = await this.resolveServerSettings(previous);

		for (let [key, action] of Object.entries(serverSettingsActions)) {
			if (current[key] !== undefined && !util.isDeepStrictEqual(current[key], previous[key])) {
				await action(this, current[key]);
			}
		}
	}

	/**
	 * Enable or disable the player whitelist
	 *
	 * @param {boolean} enable -
	 *     True to enable the whitelist, False to disable the whitelist.
	 */
	async updateFactorioWhitelist(enable) {
		if (!enable) {
			await this.sendRcon("/whitelist disable");
		}

		if (this.config.get("factorio.sync_whitelist")) {
			await this.sendRcon("/whitelist clear");
			for (let player of this._slave.whitelist) {
				await this.sendRcon(`/whitelist ${player}`);
			}
		}

		if (enable) {
			await this.sendRcon("/whitelist enable");
		}
	}

	async adminlistUpdateEventHandler(message) {
		if (!this.config.get("factorio.sync_adminlist")) {
			return;
		}

		let { name, admin } = message.data;
		let command = admin ? `/promote ${name}` : `/demote ${name}`;
		await this.sendRcon(command);
	}

	async banlistUpdateEventHandler(message) {
		if (!this.config.get("factorio.sync_banlist")) {
			return;
		}

		let { name, banned, reason } = message.data;
		let command = banned ? `/ban ${name} ${reason}` : `/unban ${name}`;
		await this.sendRcon(command);
	}

	async whitelistUpdateEventHandler(message) {
		if (!this.config.get("factorio.sync_whitelist")) {
			return;
		}

		let { name, whitelisted } = message.data;
		let command = whitelisted ? `/whitelist add ${name}` : `/whiteliste remove ${name}`;
		await this.sendRcon(command);
	}


	/**
	 * Stop the instance
	 */
	async stop() {
		if (this._status === "stopped") {
			return;
		}
		this.notifyStatus("stopping");

		// XXX this needs more thought to it
		if (this.server._state === "running") {
			await libPlugin.invokeHook(this.plugins, "onStop");
			await this.server.stop();
			await this.sendSaveListUpdate();
		}
	}

	async kill() {
		if (this._status === "stopped") {
			return;
		}
		await this.server.kill(true);
	}

	async masterConnectionEventEventHandler(message) {
		await libPlugin.invokeHook(this.plugins, "onMasterConnectionEvent", message.data.event);
	}

	async prepareMasterDisconnectRequestHandler() {
		await libPlugin.invokeHook(this.plugins, "onPrepareMasterDisconnect");
	}

	async getMetricsRequestHandler() {
		let results = [];
		if (!["stopped", "stopping"].includes(this._status)) {
			let pluginResults = await libPlugin.invokeHook(this.plugins, "onMetrics");
			for (let metricIterator of pluginResults) {
				for await (let metric of metricIterator) {
					results.push(libPrometheus.serializeResult(metric));
				}
			}
		}

		let pid = this.server.pid;
		if (pid) {
			let stats = await pidusage(pid);
			instanceFactorioCpuTime.labels(String(this.id)).set(stats.ctime / 1000);
			instanceFactorioMemoryUsage.labels(String(this.id)).set(stats.memory);
		}

		return { results };
	}

	async startInstanceRequestHandler(message) {
		let saveName = message.data.save;
		try {
			await this.prepare();
			saveName = await this.prepareSave(saveName);
		} catch (err) {
			this.notifyExit();
			await this.sendSaveListUpdate();
			throw err;
		}

		try {
			await this.start(saveName);
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	async loadScenarioRequestHandler(message) {
		if (this.config.get("factorio.enable_save_patching")) {
			this.notifyExit();
			throw new libErrors.RequestError("Load scenario cannot be used with save patching enabled");
		}

		try {
			await this.prepare();
		} catch (err) {
			this.notifyExit();
			await this.sendSaveListUpdate();
			throw err;
		}

		let { scenario, seed, map_gen_settings, map_settings } = message.data;
		try {
			await this.startScenario(scenario, seed, map_gen_settings, map_settings);
		} catch (err) {
			await this.stop();
			throw err;
		}
	}

	async listSavesRequestHandler(message) {
		return {
			list: await Instance.listSaves(this.server.writePath("saves"), this._loadedSave),
		};
	}

	async createSaveRequestHandler(message) {
		this.notifyStatus("creating_save");
		try {
			this.logger.verbose("Writing server-settings.json");
			await this.writeServerSettings();

			this.logger.verbose("Creating save .....");
			// eslint-disable-next-line no-use-before-define
			await symlinkMods(this, "sharedMods");

		} catch (err) {
			this.notifyExit();
			await this.sendSaveListUpdate();
			throw err;
		}

		this.server.on("exit", () => this.notifyExit());
		let { name, seed, map_gen_settings, map_settings } = message.data;
		await this.server.create(name, seed, map_gen_settings, map_settings);
		await this.sendSaveListUpdate();
		this.logger.info("Successfully created save");
	}

	async exportDataRequestHandler() {
		this.notifyStatus("exporting_data");
		try {
			this.logger.verbose("Writing server-settings.json");
			await this.writeServerSettings();

			this.logger.info("Exporting data .....");
			// eslint-disable-next-line no-use-before-define
			await symlinkMods(this, "sharedMods");
			let zip = await libFactorio.exportData(this.server);

			let content = await zip.generateAsync({ type: "nodebuffer" });
			let url = new URL(this._slave.config.get("slave.master_url"));
			url.pathname += "api/upload-export";
			let response = await phin({
				url, method: "PUT",
				data: content,
				core: { ca: this._slave.tlsCa },
				headers: {
					"Content-Type": "application/zip",
					"x-access-token": this._slave.config.get("slave.master_token"),
				},
			});
			if (response.statusCode !== 200) {
				throw Error(`Upload failed: ${response.statusCode} ${response.statusMessage}: ${response.body}`);
			}

		} finally {
			this.notifyExit();
		}
	}

	async stopInstanceRequestHandler() {
		await this.stop();
	}

	async killInstanceRequestHandler() {
		await this.kill();
	}

	async sendRconRequestHandler(message) {
		let result = await this.sendRcon(message.data.command);
		return { result };
	}

	/**
	 * Name of the instance
	 *
	 * This should not be used for filesystem paths.  See .path() for that.
	 */
	get name() {
		return this.config.get("instance.name");
	}

	/**
	 * Return path in instance
	 *
	 * Creates a path using path.join with the given parts that's relative to
	 * the directory of the instance.  For example instance.path("mods")
	 * returns a path to the mods directory of the instance.  If no parts are
	 * given it returns a path to the directory of the instance.
	 *
	 * @returns {string} path in instance directory.
	 */
	path(...parts) {
		return path.join(this._dir, ...parts);
	}
}

module.exports = Instance;

// For testing only
module.exports._symlinkMods = symlinkMods;