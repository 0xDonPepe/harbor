# Catalog qualification catalog-2026-10-12T18-21-35-harbor-q09

Host: Ubuntu 24.04.5 LTS x86_64, Docker 29.9.0, Compose 5.6.0, Node v24.12.0

| Package | Result | Notes |
|---|---|---|
| convertx | pass | healthy after 109s; page title "ConvertX / Setup"; health 302; removed after the check; volumes and folders retained |
| docuseal | pass | healthy after 53s; page title "DocuSeal / Open Source Document Signing"; health 302; removed after the check; volumes and folders retained |
| grocy | pass | healthy after 36s; page title "Login / Grocy"; health 302; removed after the check; volumes and folders retained |
| localai | pass | healthy after 47s; page title "LocalAI"; health 301; removed after the check; volumes and folders retained |
| papra | pass | healthy after 51s; page title "Papra - Document archiving and sharing platform"; health 200; removed after the check; volumes and folders retained |
| pastefy | pass | healthy after 48s; page title "Pastefy • Share your code snippets"; health 200; removed after the check; volumes and folders retained |
| snapdrop | pass | healthy after 32s; page title "Snapdrop"; health 200; removed after the check; volumes and folders retained |
| trilium-notes | fail | harbor install trilium-notes --name trilium-notes-q1821 --yes exited 1:  
      "cursor": "161",
      "at": "2026-10-12T18:32:31Z",
      "phase": "checking",
      "message": "readiness attempt 90: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "162",
      "at": "2026-10-12T18:32:51Z",
      "phase": "checking",
      "message": "readiness attempt 100: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "163",
      "at": "2026-10-12T18:33:11Z",
      "phase": "checking",
      "message": "readiness attempt 110: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "164",
      "at": "2026-10-12T18:33:31Z",
      "phase": "checking",
      "message": "readiness attempt 120: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "165",
      "at": "2026-10-12T18:33:51Z",
      "phase": "checking",
      "message": "readiness attempt 130: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "166",
      "at": "2026-10-12T18:34:11Z",
      "phase": "checking",
      "message": "readiness attempt 140: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "167",
      "at": "2026-10-12T18:34:31Z",
      "phase": "checking",
      "message": "readiness attempt 150: connect ECONNREFUSED 127.0.0.1:18087"
    },
    {
      "cursor": "168",
      "at": "2026-10-12T18:34:31Z",
      "phase": "failed",
      "message": "install failed: readiness check did not pass within 300s (last: connect ECONNREFUSED 127.0.0.1:18087); containers were kept for inspection"
    }
  ]
}
 |
