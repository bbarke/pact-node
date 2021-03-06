import chai = require("chai");
import chaiAsPromised = require("chai-as-promised");
import childProcess = require("child_process");
import q = require("q");
import request = require("request");
import path = require("path");
import _ = require("underscore");
import {ChildProcess} from "child_process";
import {ServerOptions} from "../src/server";
import decamelize = require("decamelize");
import provider from "../test/integration/provider";

const http = q.denodeify(request);
const pkg = require("../package.json");
const isWindows = process.platform === "win32";
chai.use(chaiAsPromised);
const expect = chai.expect;

describe("Pact CLI Spec", () => {
	afterEach(() => CLI.stopAll());

	it("should show the proper version", () => {
		return expect(CLI.runSync(["--version"]).then((cp) => cp.stdout)).to.eventually.contain(pkg.version);
	});

	it("should show the help options with the commands available", () => {
		const p = CLI.runSync(["--help"]).then((cp) => cp.stdout);
		return q.all([
			expect(p).to.eventually.contain("USAGE"),
			expect(p).to.eventually.contain("pact "),
			expect(p).to.eventually.contain("mock"),
			expect(p).to.eventually.contain("verify"),
		]);
	});

	describe("Mock Command", () => {
		it("should display help", () => {
			const p = CLI.runSync(["mock", "--help"]).then((cp) => cp.stdout);
			return q.all([
				expect(p).to.eventually.contain("USAGE"),
				expect(p).to.eventually.contain("pact mock"),
			]);
		});

		it("should run mock service", () => {
			const p = CLI.runMock({port: 9500}).then((cp) => cp.stdout);
			return q.all([
				expect(p).to.eventually.be.fulfilled,
				expect(p).to.eventually.contain("Creating Pact with PID"),
			]);
		});
	});

	describe("Verify Command", () => {
		it("should display help", () => {
			const p = CLI.runSync(["verify", "--help"]).then((cp) => cp.stdout);
			return q.all([
				expect(p).to.eventually.contain("USAGE"),
				expect(p).to.eventually.contain("pact verify")
			]);
		});

		it("should fail if missing 'provider-base-url' argument", () => {
			return expect(CLI.runSync(["verify"]).then((cp) => cp.stderr)).to.eventually.contain("Must provide the providerBaseUrl argument");
		});

		context("with mock broker", () => {
			let server;
			const PORT = 9123;
			const providerBaseUrl = `http://localhost:${PORT}`;

			before((done) => server = provider.listen(PORT, () => done()));
			after(() => server.close());

			it("should work pointing to fake broker", () => {
				const p = CLI.runSync(["verify", "--provider-base-url", providerBaseUrl, "--pact-urls", path.resolve(__dirname, "integration/me-they-success.json")]).then((cp) => cp.stdout);
				return expect(p).to.eventually.be.fulfilled;
			});
		});
	});
});

class CLI {
	public static runMock(options: ServerOptions = {}): q.Promise<CLI> {
		const args = _.chain(options)
			.pairs()
			.map((arr) => [`--${decamelize(arr[0], "-")}`, `${arr[1]}`])
			.flatten()
			.value();

		return this.run(["mock"].concat(args))
			.tap(() => this.checkMockStarted(options));
	}

	public static run(args: string[] = []): q.Promise<CLI> {
		const opts = {
			cwd: __dirname,
			detached: !isWindows,
			windowsVerbatimArguments: isWindows
		};
		args = [this.__cliPath].concat(args);
		const proc = childProcess.spawn("node", args, opts);
		this.__children.push(proc);
		return q(new CLI(proc))
			.tap((cli) => this.commandRunning(cli));
	}

	public static runSync(args: string[] = []): q.Promise<CLI> {
		return this.run(args)
			.tap((cp) => {
				if ((cp.process as any).exitCode === null) {
					// console.log("check when exiting");
					const deferred = q.defer<CLI>();
					cp.process.once("exit", () => deferred.resolve());
					return deferred.promise;
				}
			});
	}

	public static remove(proc: ChildProcess) {
		for (let i = 0; i < this.__children.length; i++) {
			if (this.__children[i] === proc) {
				this.__children.splice(i, 1);
				break;
			}
		}
	}

	public static stopAll() {
		for (let child of this.__children) {
			isWindows ? childProcess.execSync(`taskkill /f /t /pid ${child.pid}`) : process.kill(-child.pid, "SIGINT");
		}
	}

	private static readonly __children: ChildProcess[] = [];
	private static readonly __cliPath: string = require.resolve("./pact-cli.js");

	private static commandRunning(c: CLI, amount: number = 0): q.Promise<any> {
		amount++;
		const isSet = () => c.stdout.length !== 0 ? q.resolve() : q.reject();
		return isSet()
			.catch(() => {
				if (amount >= 10) {
					return q.reject(new Error("stdout never set, command probably didn't run"));
				}
				return q.delay(1000).then(() => this.commandRunning(c, amount));
			});
	}

	private static checkMockStarted(options: ServerOptions, amount: number = 0): q.Promise<any> {
		amount++;
		return this.call(options)
			.catch(() => {
				if (amount >= 10) {
					return q.reject(new Error("Pact stop failed; tried calling service 10 times with no result."));
				}
				// Try again in 1 second
				return q.delay(1000).then(() => this.checkMockStarted(options, amount));
			});
	}

	private static call(options: ServerOptions): q.Promise<any> {
		// console.log("Calling to see if pact service is up");
		options.ssl = options.ssl || false;
		options.cors = options.cors || false;
		options.host = options.host || "localhost";
		options.port = options.port || 1234;
		const config: any = {
			uri: `http${options.ssl ? "s" : ""}://${options.host}:${options.port}`,
			method: "GET",
			headers: {
				"X-Pact-Mock-Service": true,
				"Content-Type": "application/json"
			}
		};
		if (options.ssl) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
			config.agentOptions = {};
			config.agentOptions.rejectUnauthorized = false;
			config.agentOptions.requestCert = false;
			config.agentOptions.agent = false;
		}

		return http(config)
			.then((data) => data[0])
			.then((response) => {
				if (response.statusCode !== 200) {
					return q.reject();
				}
				// console.log("Pact service is up");
				return response;
			});
	}

	public get stdout(): string {
		return this.__stdout;
	}

	public get stderr(): string {
		return this.__stderr;
	}

	public readonly process: ChildProcess;
	private __stdout: string = "";
	private __stderr: string = "";

	constructor(proc: ChildProcess) {
		this.process = proc;
		this.process.stdout.setEncoding("utf8");
		this.process.stdout.on("data", (d) => {
			// console.log(d);
			this.__stdout += d;
		});
		this.process.stderr.setEncoding("utf8");
		this.process.stderr.on("data", (d) => {
			// console.log(d);
			this.__stderr += d;
		});
		this.process.once("exit", (code) => {
			// console.log("EXITED " + code);
			CLI.remove(this.process);
			this.process.stdout.removeAllListeners();
			this.process.stderr.removeAllListeners();
		});
	}
}
