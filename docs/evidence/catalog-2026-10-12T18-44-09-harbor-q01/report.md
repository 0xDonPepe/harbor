# Catalog qualification catalog-2026-10-12T18-44-09-harbor-q01

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| metube | pass | healthy after 38s; page title "MeTube"; health 200; removed after the check; volumes and folders retained |
| metube (external storage) | fail | ssh command failed (exit 1): docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(docker ps -q --filter label=io.harbor.preview/instance=dd36bcb3-2c62-46c8-bff0-5177ff266a2d)
docker: 'docker inspect' requires at least 1 argument

Usage:  docker inspect [OPTIONS] NAME/ID [NAME/ID...]

See 'docker inspect --help' for more information

 |
