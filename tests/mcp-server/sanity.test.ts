import assert from "node:assert"
import { describe, it } from "node:test"

describe("sanity", () => {
	it("should pass", () => {
		assert.strictEqual(1 + 1, 2)
	})
})
