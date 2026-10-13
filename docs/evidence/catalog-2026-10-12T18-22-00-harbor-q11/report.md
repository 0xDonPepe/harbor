# Catalog qualification catalog-2026-10-12T18-22-00-harbor-q11

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| downtify | pass | healthy after 41s; page title "Downtify"; health 200; removed after the check; volumes and folders retained |
| downtify (external storage) | pass | healthy after 27s; page title "Downtify"; health 200; external storage: --storage downloads-downtify=/mnt/harbor-test-storage/downtify-downloads-downtify-q1822 mounted as bind; removed after the check; volumes and folders retained |
| flaresolverr | pass | healthy after 45s; page title "FlareSolverr Status"; health 200; removed after the check; volumes and folders retained |
| heimdall | pass | healthy after 47s; page title "Heimdall"; health 200; removed after the check; volumes and folders retained |
| metube | pass | healthy after 39s; page title "MeTube"; health 200; removed after the check; volumes and folders retained |
| metube (external storage) | fail | ssh command failed (exit 1): docker inspect -f '{{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}} {{end}}' $(docker ps -q --filter label=io.harbor.preview/instance=bd8822c1-1a95-45b2-8ca4-63db025c17ad)
docker: 'docker inspect' requires at least 1 argument

Usage:  docker inspect [OPTIONS] NAME/ID [NAME/ID...]

See 'docker inspect --help' for more information

 |
| passky-server | pass | healthy after 43s; page title "Passky"; health 200; removed after the check; volumes and folders retained |
| spacebot | pass | healthy after 50s; page title "Spacebot"; health 200; removed after the check; volumes and folders retained |
| termix | pass | healthy after 48s; page title "Termix"; health 200; removed after the check; volumes and folders retained |
| valorgrid | pass | healthy after 48s; page title "ValorGrid"; health 200; removed after the check; volumes and folders retained |
