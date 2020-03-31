#!/usr/bin/env python

#
# This script tries to show dependencies stored in PD,
# starting from the SNOW cmdb_ci_service table.
#

import json
import requests
import pd
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("pd_api_key", help="PagerDuty API key")
parser.add_argument("snow_user", help="ServiceNow username")
parser.add_argument("snow_pass", help="ServiceNow password")
parser.add_argument("snow_host", help="ServiceNow hostname")
args = parser.parse_args()

def get_snow_services(username, password, host):
    services = []
    offset = 0
    page_size = 1000
    more = True

    while more:
        r = requests.get(
            f"https://{host}/api/now/table/cmdb_ci_service",
            auth=(username, password),
            params={"sysparm_limit": f"{page_size}", "sysparm_offset": f"{offset}"}
        )
        offset += page_size

        try:
            if r.status_code != 200:
                print(f"Oops, got error {r.status_code}: {t.text}")
                more = False
            else:
                fetched = r.json()["result"]
                if len(fetched) > 0:
                    services.extend(fetched)
                else:
                    more = False
        except:
            print(f"Oops, couldn't get JSON from '{r.text}'")
            more = False

    return services

print("Getting SNOW services... ", end="", flush=True)
snow_services = get_snow_services(args.snow_user, args.snow_pass, args.snow_host)
print(f"got {len(snow_services)}")

snow_services = [service for service in snow_services 
    if service["x_pd_integration_pagerduty_service"]
    or service["x_pd_integration_pagerduty_business_service"]]

print(f"  {len(snow_services)} SNOW services that have PagerDuty ID's")

business_services = [service for service in snow_services if service["service_classification"] == "Business Service"]
technical_services = [service for service in snow_services if service["service_classification"] != "Business Service"]

print(f"  There are {len(business_services)} SNOW business services and {len(technical_services)} SNOW technical services.")

print("Getting PD services... ", end="", flush=True)
pd_services = pd.fetch_services(token=args.pd_api_key, params={"query": "SN:"})
print(f"got {len(pd_services)}")

print("Getting PD business services... ", end="", flush=True)
pd_business_services = [service for service in pd.fetch(token=args.pd_api_key, endpoint="business_services") if service['name'].startswith("SN:")]
print(f"got {len(pd_business_services)}")

pd_services_dict = {service['id']: service for service in pd_services}
pd_services_dict.update({service['id']: service for service in pd_business_services})

for service in snow_services:
    if service["x_pd_integration_pagerduty_service"]:
        pd_id = service["x_pd_integration_pagerduty_service"]
        endpoint = f"service_dependencies/technical_services/{pd_id}"
    elif service["x_pd_integration_pagerduty_business_service"]:
        pd_id = service["x_pd_integration_pagerduty_business_service"]
        endpoint = f"service_dependencies/business_services/{pd_id}"
    else:
        print(f"Couldn't find PD ID for {service['name']}")
        continue

    try:
        pd_service_name = pd_services_dict[pd_id]['name']
        pd_service_type = pd_services_dict[pd_id]['type']
    except:
        pd_service_name = "(unknown service)"
        pd_service_type = "(unknown type)"

    r = pd.request(token=args.pd_api_key, endpoint=endpoint)
    if 'relationships' in r and r['relationships']:
        print(f"{pd_service_name} ({pd_service_type} {pd_id}):")
        relationships = r['relationships']
        for relationship in relationships:
            if relationship['supporting_service']['id'] == pd_id:
                verb = "Supports"
                target_pd_id = relationship['dependent_service']['id']
            elif relationship['dependent_service']['id'] == pd_id:
                verb = "Depends on"
                target_pd_id = relationship['supporting_service']['id']
            else:
                print(f"PD ID is not in relationship: {json.dumps(relationship)}")
                continue
            try:
                target_name = pd_services_dict[target_pd_id]['name']
                target_type = pd_services_dict[target_pd_id]['type']
            except:
                target_name = "(unknown service)"
                target_type = "(unknown type)"
            print(f"  {verb} {target_name} ({target_type} {target_pd_id})")
    else:
        print(f"{pd_service_name} ({pd_service_type} {pd_id}) has no relationships")