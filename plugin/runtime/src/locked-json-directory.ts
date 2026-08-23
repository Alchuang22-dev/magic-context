import { randomUUID } from "node:crypto";
import {
	mkdir,
	open,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export interface LockedJsonDirectoryOptions {
	lockTimeoutMs?: number;
	staleLockMs?: number;
}

export class LockedJsonDirectoryError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "LockedJsonDirectoryError";
	}
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error
		? String(error.code)
		: undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/**
 * Atomic JSON document Implementation shared by runtime storage Adapters.
 * The filename is supplied by the Adapter and never derived from user input
 * inside this class.
 */
export class LockedJsonDirectory {
	readonly #lockTimeoutMs: number;
	readonly #staleLockMs: number;

	constructor(
		readonly directory: string,
		options: LockedJsonDirectoryOptions = {},
	) {
		this.#lockTimeoutMs = Math.max(100, options.lockTimeoutMs ?? 2_000);
		this.#staleLockMs = Math.max(
			this.#lockTimeoutMs,
			options.staleLockMs ?? 30_000,
		);
	}

	async read<T>(
		fileName: string,
		fallback: () => T,
		parse: (value: unknown) => T,
	): Promise<T> {
		const filePath = join(this.directory, fileName);
		try {
			return clone(parse(JSON.parse(await readFile(filePath, "utf8"))));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return clone(fallback());
			throw new LockedJsonDirectoryError("failed to read JSON document", {
				cause: error,
			});
		}
	}

	async update<T, R>(
		fileName: string,
		fallback: () => T,
		parse: (value: unknown) => T,
		update: (value: T) => { value: T; result: R },
	): Promise<R> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const filePath = join(this.directory, fileName);
		const lockPath = `${filePath}.lock`;
		const lock = await this.#acquireLock(lockPath);
		try {
			const current = await this.read(fileName, fallback, parse);
			const outcome = update(clone(current));
			await this.#write(filePath, outcome.value);
			return clone(outcome.result);
		} finally {
			await lock.close().catch(() => undefined);
			await unlink(lockPath).catch(() => undefined);
		}
	}

	async #write<T>(filePath: string, value: T): Promise<void> {
		const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			await rename(temporaryPath, filePath);
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw new LockedJsonDirectoryError("failed to persist JSON document", {
				cause: error,
			});
		}
	}

	async #acquireLock(lockPath: string) {
		const startedAt = Date.now();
		for (;;) {
			try {
				return await open(lockPath, "wx", 0o600);
			} catch (error) {
				if (errorCode(error) !== "EEXIST") {
					throw new LockedJsonDirectoryError(
						"failed to acquire JSON document lock",
						{ cause: error },
					);
				}
				try {
					const lockStat = await stat(lockPath);
					if (Date.now() - lockStat.mtimeMs > this.#staleLockMs) {
						await unlink(lockPath);
						continue;
					}
				} catch (statError) {
					if (errorCode(statError) === "ENOENT") continue;
				}
				if (Date.now() - startedAt >= this.#lockTimeoutMs) {
					throw new LockedJsonDirectoryError(
						"timed out acquiring JSON document lock",
					);
				}
				await delay(10);
			}
		}
	}
}
