import { describe, it } from "node:test"
import assert from "node:assert"

describe("sanity", () => {
	it("should pass", () => {
		assert.strictEqual(1 + 1, 2)
	})
})
