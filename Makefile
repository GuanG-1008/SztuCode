.PHONY: typecheck test build docs docs-links verify

typecheck:
	npm run typecheck

test:
	npm test

build:
	npm run build

docs:
	npm run docs:protocol

docs-links:
	npm run docs:links

verify: typecheck test build docs docs-links
