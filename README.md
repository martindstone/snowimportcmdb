# snowimportcmdb

tools for importing snow cmdb entries to pd

## Requirements:
Install PagerDuty ServiceNow integration according to the integration guide. Then add a new field to cmdb_ci:

    Table:          Configuration Item [cmdb_ci]
    Type:           String
    Column Label:   PagerDuty business service
    Column Name:    x_pd_integration_pagerduty_business_service
    Length:         10

Then navigate to PagerDuty > Configuration Files > Script includes and replace the PagerDutyProvisioning script include with the contenct of PagerDutyProvisioning.js. Make sure to back up the original version (Insert and Stay) so you can undo your changes easily!

## Tools:

### snow_provision.js 

This script starts from cmdb_ci_service table and walks down dependencies, creating PagerDuty technical and business services as it goes, and setting up dependencies in PagerDuty. It stops walking when it reaches the end, or when the depth exceeds the max_depth variable. 

It's meant to be run as a "fix script" in ServiceNow - go to System Definition > Scripts - Background and paste this whole file in there. It can take a long time to run. Be sure that you understand what it is doing before you run it!

### snow_clear.js

This script starts from cmdb_ci_service table and walks down dependencies, clearing PagerDuty technical and business services as it goes. It stops walking when it reaches the end, or when the depth exceeds the max_depth variable. 

It's meant to be run as a "fix script" in ServiceNow - go to System Definition > Scripts - Background and paste this whole file in there. Be sure that you understand what it is doing before you run it!

### show.py

This script tries to show dependencies stored in PD, starting from the SNOW cmdb_ci_service table. To use:

    python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt
    python show.py <YOUR_PD_API_KEY> <YOUR_SNOW_USER> <YOUR_SNOW_PASS> <YOUR_SNOW_HOSTNAME>

### destroy.py

This script just deletes services, business services whose names begin with the specified prefix, along with any associated escalation  policies. Be careful with it!

    python3 -m venv venv && . venv/bin/activate && pip install -r requirements.txt
    python show.py <YOUR_PD_API_KEY>
