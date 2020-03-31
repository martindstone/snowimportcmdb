import json
import requests

from requests.auth import HTTPBasicAuth

page_size = 1000

def get_services(username, password, host):
	services = []
	offset = 0
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

def get_ci(username, password, host, id):
	r = requests.get(
		f"https://{host}/api/now/cmdb/instance/cmdb_ci/{id}",
		auth=(username, password)
	)
	try:
		return r.json()["result"]
	except:
		return None

def get_outbound_relations(username, password, host, id):
	r = requests.get(
		f"https://{host}/api/now/cmdb/instance/cmdb_ci_service/{id}",
		auth=(username, password)
	)
	try:
		return r.json()["result"]["outbound_relations"]
	except:
		return None

def get_inbound_relations(username, password, host, id):
	r = requests.get(
		f"https://{host}/api/now/cmdb/instance/cmdb_ci_service/{id}",
		auth=(username, password)
	)
	try:
		return r.json()["result"]["inbound_relations"]
	except:
		return None

def get_dependencies_up(username, password, host, id):
	items = []
	relations = get_inbound_relations(username, password, host, id)
	if not relations:
		return items
	item_links = [relation["target"]["link"] for relation in relations if relation["type"]["display_value"] == "Depends on::Used by"]
	for item_link in item_links:
		r = requests.get(
			item_link,
			auth=(username, password)
		)
		try:
			items.append(r.json()["result"])
		except:
			pass
	return items

def get_dependencies_down(username, password, host, id):
	items = []
	relations = get_outbound_relations(username, password, host, id)
	if not relations:
		return items
	item_links = [relation["target"]["link"] for relation in relations if relation["type"]["display_value"] == "Depends on::Used by"]
	for item_link in item_links:
		r = requests.get(
			item_link,
			auth=(username, password)
		)
		try:
			items.append(r.json()["result"])
		except:
			pass
	return items

def walk_down(username, password, host, id):
	own_ci = get_ci(username, password, host, id)
	dependencies_down = get_dependencies_down(username, password, host, id)

	to_add = []
	if len(dependencies_down) > 0:
		for dependency in dependencies_down:
			to_add.append({
				"name": dependency['attributes']['name'],
				"sys_id": dependency['attributes']['sys_id'],
				"dependencies_down": walk_down(username, password, host, dependency['attributes']['sys_id'])
			})

	return to_add
