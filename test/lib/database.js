"use strict";
const assert = require("assert").strict;
const fs = require("fs-extra");
const path = require("path");

const lib = require("@clusterio/lib");

describe("lib/database", function() {
	describe("mapToObject()", function() {
		it("should throw on non-string key", function() {
			assert.throws(
				() => lib.mapToObject(new Map([[1, 1]])),
				new Error("Expected all keys to be string but got number")
			);
			assert.throws(
				() => lib.mapToObject(new Map([[Symbol("test"), 1]])),
				new Error("Expected all keys to be string but got symbol")
			);
		});

		it("should throw convert a map to an object", function() {
			assert.deepEqual(
				lib.mapToObject(new Map([["a", 1], ["b", true]])),
				{ "a": 1, "b": true }
			);
		});
	});

	describe("loadJsonAsMap()", function() {
		let badTypes = ["null", "array", "number", "string", "boolean"];

		for (let type of badTypes) {
			it(`should reject on ${type} JSON`, async function() {
				await assert.rejects(
					lib.loadJsonAsMap(path.join("test", "file", "json", `${type}.json`)),
					new Error(`Expected object but got ${type}`)
				);
			});
		}

		it("should work on empty object JSON", async function() {
			assert.deepEqual(
				await lib.loadJsonAsMap(path.join("test", "file", "json", "object.json")),
				new Map()
			);
		});

		it("should work on object JSON", async function() {
			assert.deepEqual(
				await lib.loadJsonAsMap(path.join("test", "file", "json", "load_map.json")),
				new Map([["a", 1], ["b", true]])
			);
		});

		it("should give an empty Map for non-existant file", async function() {
			assert.deepEqual(
				await lib.loadJsonAsMap(path.join("test", "file", "json", "does-not-exist")),
				new Map()
			);
		});
	});

	describe("saveMapAsJson()", function() {
		it("should save a mapping as JSON", async function() {
			let testFile = path.join("temp", "test", "save_map.json");
			async function deleteTestFile() {
				try {
					await fs.unlink(testFile);
				} catch (err) {
					/* istanbul ignore if */
					if (err.code !== "ENOENT") {
						throw err;
					}
				}
			}

			await deleteTestFile();
			await lib.saveMapAsJson(
				testFile, new Map([["c", {}], ["d", "foo"]])
			);

			assert.equal(
				await fs.readFile(testFile, { encoding: "utf-8" }),
				'{\n\t"c": {},\n\t"d": "foo"\n}'
			);
		});
	});

	describe("loadJsonArrayAsMap()", function() {
		let badTypes = ["null", "object", "number", "string", "boolean"];

		for (let type of badTypes) {
			it(`should reject on ${type} JSON`, async function() {
				await assert.rejects(
					lib.loadJsonArrayAsMap(path.join("test", "file", "json", `${type}.json`)),
					new Error(`Expected array but got ${type}`)
				);
			});
		}

		it("should reject on null element", async function() {
			await assert.rejects(
				lib.loadJsonArrayAsMap(path.join("test", "file", "json", "array_null.json")),
				new Error("Expected all elements to be objects")
			);
		});

		it("should reject on element missing id", async function() {
			await assert.rejects(
				lib.loadJsonArrayAsMap(path.join("test", "file", "json", "array_object.json")),
				new Error("Expected all elements to have an id property")
			);
		});

		it("should work on empty array JSON", async function() {
			assert.deepEqual(
				await lib.loadJsonArrayAsMap(path.join("test", "file", "json", "array.json")),
				new Map()
			);
		});

		it("should work on array JSON", async function() {
			assert.deepEqual(
				await lib.loadJsonArrayAsMap(path.join("test", "file", "json", "load_array_map.json")),
				new Map([["a", { id: "a" }], ["b", { id: "b" }]])
			);
		});

		it("should give an empty Map for non-existant file", async function() {
			assert.deepEqual(
				await lib.loadJsonArrayAsMap(path.join("test", "file", "json", "does-not-exist")),
				new Map()
			);
		});
	});

	describe("saveMapAsJsonArray()", function() {
		it("should save a mapping as JSON", async function() {
			let testFile = path.join("temp", "test", "save_array_map.json");
			async function deleteTestFile() {
				try {
					await fs.unlink(testFile);
				} catch (err) {
					/* istanbul ignore if */
					if (err.code !== "ENOENT") {
						throw err;
					}
				}
			}

			await deleteTestFile();
			await lib.saveMapAsJsonArray(
				testFile, new Map([["c", { id: "c" }], ["d", { id: "d" }]])
			);

			assert.equal(
				await fs.readFile(testFile, { encoding: "utf-8" }),
				'[\n\t{\n\t\t"id": "c"\n\t},\n\t{\n\t\t"id": "d"\n\t}\n]'
			);
		});
	});

	describe("class ItemDatabase", function() {
		describe("constructor()", function() {
			it("should create an empty database with no args", function() {
				let items = new lib.ItemDatabase();
				assert.deepEqual(items._items, new Map());
			});

			it("should restore the passed serialized database", function() {
				let items = new lib.ItemDatabase({ "a": 1, "b": 2 });
				assert.deepEqual(items._items, new Map([["a", { normal: 1 }], ["b", { normal: 2 }]]));
			});

			it("should throw on invalid serialized database", function() {
				assert.throws(
					() => new lib.ItemDatabase({ "a": NaN }),
					new Error("count must be a number")
				);

				assert.throws(
					() => new lib.ItemDatabase({ "a": "a" }),
					new Error("count must be a number")
				);
			});
		});

		describe(".serialize()", function() {
			it("should return a serialized database", function() {
				let items = new lib.ItemDatabase({ "a": 10 });
				assert.deepEqual(items.serialize(), { "a": { normal: 10 } });
			});

			it("should remove zero count entries", function() {
				let items = new lib.ItemDatabase({ "a": 0 });
				assert.deepEqual(items.serialize(), {});
			});
		});

		describe(".size", function() {
			it("should give an approximate size of the database", function() {
				let items = new lib.ItemDatabase({ "a": 10 });
				assert.equal(items.size, 1);
			});
		});

		describe(".getItemCount()", function() {
			it("should return the count of the given item", function() {
				let items = new lib.ItemDatabase({ "a": 10 });
				assert.equal(items.getItemCount("a", "normal"), 10);
			});

			it("should return zero if item does not exist", function() {
				let items = new lib.ItemDatabase();
				assert.equal(items.getItemCount("b", "normal"), 0);
			});

			it("should throw on invalid name", function() {
				let items = new lib.ItemDatabase();
				assert.throws(
					() => items.getItemCount(2, "normal"),
					new Error("name must be a string")
				);
			});
		});

		describe(".addItem()", function() {
			it("should add a new item", function() {
				let items = new lib.ItemDatabase();
				items.addItem("a", 10, "normal");
				assert.deepEqual(items._items, new Map([["a", { normal: 10 }]]));
			});

			it("should add an existing item", function() {
				let items = new lib.ItemDatabase({ "a": 10 });
				items.addItem("a", 10, "normal");
				assert.deepEqual(items._items, new Map([["a", { normal: 20 }]]));
			});

			it("should throw on invalid name", function() {
				let items = new lib.ItemDatabase();
				assert.throws(
					() => items.addItem(2, 10, "normal"),
					new Error("name must be a string")
				);
			});

			it("should throw on invalid count", function() {
				let items = new lib.ItemDatabase();
				assert.throws(
					() => items.addItem("a", NaN, "normal"),
					new Error("count must be a number")
				);
				assert.throws(
					() => items.addItem("a", "1", "normal"),
					new Error("count must be a number")
				);
			});
		});

		describe(".removeItem()", function() {
			it("should remove an existing item", function() {
				let items = new lib.ItemDatabase({ "a": 20 });
				items.removeItem("a", 10, "normal");
				assert.deepEqual(items._items, new Map([["a", { normal: 10 }]]));
			});

			it("should turn a non-existing item negative", function() {
				let items = new lib.ItemDatabase();
				items.removeItem("a", 10, "normal");
				assert.deepEqual(items._items, new Map([["a", { normal: -10 }]]));
			});

			it("should throw on invalid name", function() {
				let items = new lib.ItemDatabase();
				assert.throws(
					() => items.removeItem(2, 10, "normal"),
					new Error("name must be a string")
				);
			});

			it("should throw on invalid count", function() {
				let items = new lib.ItemDatabase();
				assert.throws(
					() => items.removeItem("a", "b", "normal"),
					new Error("count must be a number")
				);
				assert.throws(
					() => items.removeItem("a", "1", "normal"),
					new Error("count must be a number")
				);
			});
		});
	});
});
