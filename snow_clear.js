/*
	This script starts from cmdb_ci_service table and walks down dependencies,
	clearing PagerDuty technical and business services as it goes.

	It stops walking when it reaches the end, or
	when the depth exceeds the max_depth variable, set below.

	It's meant to be run as a "fix script" in ServiceNow - go to 
		System Definition > Scripts - Background
	and paste this whole file in there.
*/

var max_depth = 1;

var pd = new x_pd_integration.PagerDutyProvisioning();

var service = new GlideRecord('cmdb_ci_service');
service.addQuery('name', '!=', 'All');
service.query();

var clear = function (ci) {
	ci.setValue("x_pd_integration_pagerduty_business_service", "");
	ci.setValue("x_pd_integration_pagerduty_service", "");
	ci.setValue("x_pd_integration_pagerduty_webhook", "");
	ci.update();
	return("cleared PD values for " + ci.getValue("name"));
}

function getChildren(ci, current_depth, max_depth, provision_function) {
	if (current_depth > max_depth) {
		return(["max_depth"]);
	}

	var cmdb_rel_ci = new GlideRecord('cmdb_rel_ci');
	cmdb_rel_ci.addQuery('parent', ci.sys_id);
	cmdb_rel_ci.query();

	if (cmdb_rel_ci.getRowCount() == 0) {
		return(["no rows for ci " + ci.getValue("sys_id")]);
	}

	var to_add = [];

	while (cmdb_rel_ci.next()) {
		var rel_type = cmdb_rel_ci.type.getRefRecord();
		var child = cmdb_rel_ci.child.getRefRecord();
		provision_msg = provision_function(child);
		to_add.push({
			"name": child.getValue("name"),
			"sys_class_name": child.getValue("sys_class_name"),
			"sys_id": child.getValue("sys_id"),
			"relationship_to_parent": rel_type.getValue("name").split("::")[1],
			"service_classification": child.getValue("service_classification"),
			"stuff": [
				provision_msg,
			],
			"children": getChildren(child, current_depth + 1, max_depth, provision_function)
		});
	}
	return to_add;
}


var provision_function = clear;

var current_depth = 0;
var services = [];
while (service.next()) {
	provision_msg = provision_function(service);
	services.push({
		"name": service.getValue("name"),
		"sys_class_name": service.getValue("sys_class_name"),
		"sys_id": service.getValue("sys_id"),
		"relationship_to_parent": "no parent",
		"service_classification": service.getValue("service_classification"),
		"stuff": [
			provision_msg,
		],
		"children": getChildren(service, current_depth, max_depth, provision_function)
	});
}
gs.debug(JSON.stringify(services, null, 4));