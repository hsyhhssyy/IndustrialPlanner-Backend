# sync-worker 本地开发镜像

.PHONY: build run push clean

IMAGE ?= industrial-sync-dev
TAG ?= latest
REMOTE ?= docker.io/myuser/industrial-sync-dev

build:
	docker build -t $(IMAGE):$(TAG) -f packages/sync/Dockerfile .

run:
	docker run --rm -p 8080:8080 \
	  -e LOCAL_DEV_HOST=$(LOCAL_DEV_HOST) \
	  -v sync-data:/data \
	  $(IMAGE):$(TAG)

push:
	docker tag $(IMAGE):$(TAG) $(REMOTE):$(TAG)
	docker push $(REMOTE):$(TAG)

clean:
	docker rmi $(IMAGE):$(TAG) || true
