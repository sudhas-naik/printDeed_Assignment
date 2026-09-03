.PHONY: up down wait test run typecheck

up:
	docker compose up -d --wait

down:
	docker compose down

wait:
	@until docker compose exec -T postgres pg_isready -U transfer -d transfer >/dev/null 2>&1; do sleep 1; done

test: up
	DATABASE_URL=postgres://transfer:transfer@localhost:15432/transfer \
	API_KEYS=dev-secret-key \
	npm test

run: up
	DATABASE_URL=postgres://transfer:transfer@localhost:15432/transfer \
	API_KEYS=dev-secret-key \
	npm start

typecheck:
	npm run typecheck
