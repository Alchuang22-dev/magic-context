import { join } from "node:path";

import { RuntimeMemory } from "./memory";
import {
	JsonDirectoryRuntimeMemoryStore,
	MemoryRuntimeMemoryStore,
	type RuntimeMemoryStore,
} from "./memory-store";
import {
	JsonDirectoryRuntimeStateStore,
	type JsonDirectoryRuntimeStateStoreOptions,
	MemoryRuntimeStateStore,
	type RuntimeStateStore,
} from "./state-store";

/**
 * Paired persistence seams used by the runtime. Hosts never open or migrate
 * storage; they only choose a runtime transport.
 */
export interface RuntimeStorageBackends {
	sessions: RuntimeStateStore;
	memories: RuntimeMemoryStore;
}

/** Deep Storage Module that owns session/project persistence composition. */
export class RuntimeStorage {
	readonly sessions: RuntimeStateStore;
	readonly memoryStore: RuntimeMemoryStore;
	readonly memory: RuntimeMemory;

	constructor(backends: RuntimeStorageBackends) {
		this.sessions = backends.sessions;
		this.memoryStore = backends.memories;
		this.memory = new RuntimeMemory(backends.memories);
	}

	static inMemory(): RuntimeStorage {
		return new RuntimeStorage({
			sessions: new MemoryRuntimeStateStore(),
			memories: new MemoryRuntimeMemoryStore(),
		});
	}

	static jsonDirectory(
		directory: string,
		options: JsonDirectoryRuntimeStateStoreOptions = {},
	): RuntimeStorage {
		return new RuntimeStorage({
			sessions: new JsonDirectoryRuntimeStateStore(directory, options),
			memories: new JsonDirectoryRuntimeMemoryStore(
				join(directory, "memories"),
				options,
			),
		});
	}
}
