.PHONY: backend backend-install backend-reinstall

BACKEND_DIR := backend
BACKEND_VENV := $(BACKEND_DIR)/.venv
BACKEND_PYTHON := $(BACKEND_VENV)/bin/python
BACKEND_DEPS_STAMP := $(BACKEND_VENV)/.requirements.stamp
BACKEND_HOST ?= 0.0.0.0
BACKEND_PORT ?= 8000

$(BACKEND_PYTHON):
	python3 -m venv $(BACKEND_VENV)

$(BACKEND_DEPS_STAMP): $(BACKEND_PYTHON) $(BACKEND_DIR)/requirements.txt
	$(BACKEND_PYTHON) -m pip install -r $(BACKEND_DIR)/requirements.txt
	touch $(BACKEND_DEPS_STAMP)

backend-install: $(BACKEND_DEPS_STAMP)

backend-reinstall: $(BACKEND_PYTHON)
	$(BACKEND_PYTHON) -m pip install -r $(BACKEND_DIR)/requirements.txt
	touch $(BACKEND_DEPS_STAMP)

backend: $(BACKEND_DEPS_STAMP)
	cd $(BACKEND_DIR) && .venv/bin/python -m uvicorn app.main:app --reload --host $(BACKEND_HOST) --port $(BACKEND_PORT)
