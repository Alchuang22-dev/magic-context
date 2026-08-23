import { validateRuntimeCall, validateRuntimeResult } from "../src/generated";
import golden from "./golden.json";

const results = golden.map((testCase) => ({
	id: testCase.id,
	accepted:
		testCase.target === "call"
			? validateRuntimeCall(testCase.value)
			: validateRuntimeResult(testCase.method ?? "", testCase.value),
}));

process.stdout.write(`${JSON.stringify(results)}\n`);
