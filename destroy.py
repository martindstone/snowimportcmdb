#!/usr/bin/env python

#
# This script just deletes services, business services whose names
# begin with the specified prefix, along with any associated escalation 
# policies. Be careful with it!
#
prefix = "SN:"

import json
import pd
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("pd_api_key", help="PagerDuty API key")
args = parser.parse_args()

technical_services = pd.fetch(token=args.pd_api_key, endpoint="services", params={"query": prefix})

business_services = pd.fetch(token=args.pd_api_key, endpoint="business_services")
business_services = [service for service in business_services if service['name'].startswith(prefix)]

print(f"Got {len(technical_services)} services and {len(business_services)} business services to delete")

for service in business_services:
	print(f"Deleting business service {service['name']}")
	r = pd.request(token=args.pd_api_key, endpoint=f"business_services/{service['id']}", method="DELETE")

for service in technical_services:
	print(f"Deleting escalation policy {service['escalation_policy']['summary']} ({service['escalation_policy']['id']})")
	r = pd.request(token=args.pd_api_key, endpoint=f"escalation_policies/{service['escalation_policy']['id']}", method="DELETE")
	print(f"Deleting technical service {service['name']}")
	r = pd.request(token=args.pd_api_key, endpoint=f"services/{service['id']}", method="DELETE")
