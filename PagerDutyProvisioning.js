/*

  This is a replacement PagerDutyProvisioning script include that is needed to make
  the fix scripts work. Replace the existing version in ServiceNow by going to:

    PagerDuty > Configuration Files > Script includes

  Make sure to back up the original version (Insert and Stay) so you can undo your
  changes easily.

*/


/*** Changes made to this script are not supported by PagerDuty ***/
var PagerDutyProvisioning = Class.create();
PagerDutyProvisioning.prototype = {
  initialize: function () {
    this.JSON = new global.JSON();
    this.hasError = false;
    this.errorMsg = '';
    this.autoProvisionUsers = gs.getProperty('x_pd_integration.auto_provision_users');
    this.sn2pdMapping = gs.getProperty('x_pd_integration.sn2pd_mapping');
    this.snAuthUser = gs.getProperty('x_pd_integration.sn_auth_user');
    this.snAuthUserPwd = gs.getProperty('x_pd_integration.sn_auth_userpwd');
    this.autoProvisionGrmembers = gs.getProperty('x_pd_integration.auto_provision_grmembers');
    this.autoCreateSchedule = gs.getProperty('x_pd_integration.auto_provision_group_schedules');
    this.autoCreationPdTeams = gs.getProperty('x_pd_integration.auto_creation_pd_teams');

    this.pd = new x_pd_integration.PagerDuty();
    this.userEmail = this.pd.getValidEmail(gs.getUserID());
    this.rest = new x_pd_integration.PagerDuty_REST();
  },

  /**
   * Provision a PagerDuty user, if user with email exists then update the ServiceNow user with PagerDuty ID
   * @param {GlideRecordSecure} user record
   * @return void
   */
  provisionUser: function (user) {
    var me = 'provisionUser';
    var pd = new x_pd_integration.PagerDuty();
    var id = pd.getUserIdByEmail(user.getValue('email'));
    gs.debug('{0} user lookup for {1}, id = {2}', me, user.getDisplayValue(), id);
    if (gs.nil(id)) {
      gs.debug('{0} no PagerDuty user found for {1}, creating user', me, user.getDisplayValue());

      var role = this._getDefaultUserRole();

      //create a new user
      id = this._createPDUser(user, role);


      //create contact method for user's phones
      var phoneFields = ['phone', 'mobile_phone'];
      //TODO - add support for E164 fields
      for (var i = 0; i < phoneFields.length; i++) {
        var field = phoneFields[i];
        var type = 'phone_contact_method'; //default
        if (field == 'mobile_phone')
          type = 'sms_contact_method';

        var number = user.getValue(field);
        if (!gs.nil(number)) {
          //TODO add support for country code
          var onlyNumbers = number.match(/[0-9]+/g).join("");
          var countryCode = this._getCountryCode(onlyNumbers);
          var phoneNumber = onlyNumbers.substring(countryCode.length, onlyNumbers.length);
          var contactObj = this._createContactMethod(id, type, phoneNumber, countryCode);
          if (!gs.nil(contactObj)) {
            var contactId = contactObj[0];
            var contactType = contactObj[1];
            gs.debug('{0} Ready to create notification rule contactId{1}, contactType:{2}', me, contactId, contactType);
            if (!gs.nil(contactId)) {
              //create notification rules
              this._createNotificationRule(id, contactId, contactType);
            }
          }
        }
      }

    } else {
      gs.debug('{0} found PagerDuty user for {1}, id = {2}', me, user.getDisplayValue(), id);
      this._updateUser(user, id);
    }
    return id;
  },

  _getDefaultUserRole: function () {
    var defaultRoleLabel = gs.getProperty('x_pd_integration.default_user_role');

    switch (defaultRoleLabel) {
      case 'Global Admin' : return 'admin';
      case 'Manager'      : return 'user';
      case 'Responder'    : return 'limited_user';
      case 'Observer'     : return 'observer';
      default : {
        gs.debug('faild to resolve Role for label {0}. defaulting to {1}.', defaultRoleLabel, 'user');
        return 'user';
      }
    }
  },

  _getGroupMembersRecord: function (group) {
    var me = '_getGroupMembersRecord';
    gs.debug('{0} group:{1}', me, group.getDisplayValue());
    var groupMember = new GlideRecordSecure('sys_user_grmember');
    groupMember.addQuery('group', group.sys_id);
    groupMember.query();
    return groupMember;
  },

  /**
   * Provision a group members to PD, if user with email exists then update the ServiceNow user with PagerDuty ID
   * @param {GlideRecordSecure} groupMemberRecord record
   * @return {Array} array of users PD ids
   */
  provisionGroupMembers: function (groupMemberRecord) {
    var me = 'provisionGroupMembers';
    var ids = [];

    while (groupMemberRecord.next()) {
      gs.debug('{0} groupMemberRecord:{1}', me, groupMemberRecord.user.getRefRecord().getDisplayValue());
      ids.push(this.provisionUser(groupMemberRecord.user.getRefRecord()));
    }
    return ids;
  },

  /**
   * Provision sn group members and EP into PagerDuty team
   * @param {GlideRecordSecure} group record
   * @param {String} epId - optional - EP id. When undefined then try get EP id from group field.
   **/
  createPdTeam: function (group, epId) {
    var me = 'createTeamMethod';
    gs.debug('{0} group:{1}, epId:{2}', me, group, epId);

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'teams';

    var teamId = this._createTeam(group);

    if (!epId) epId = group.x_pd_integration_pagerduty_escalation;

    if (gs.nil(epId)) {
      this._setError(me, 'Failed to get escalation policy');
      return null;
    }

    this._addEpToTeam(epId, teamId);

    this._addMappedMembersToTeam(group, teamId);

    return teamId;
  },

  addUserToPdTeam: function (pdUserId, teamId) {
    var me = 'addUserToPdTeam';
    gs.debug('{0} pdUserId:{1}, teamId:{2}', me, pdUserId, teamId);
    var response = this.rest.putREST('teams/' + teamId + '/users/' + pdUserId, {}, this.userEmail);
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (status != 204) {
      this._setError(me, 'Failed add user to team, ' + pdUserId);
    }
  },

  removeUserFromPdTeam: function (pdUserId, teamId, group) {
    var me = 'removeUserFromPdTeam';
    gs.debug('{0} pdUserId:{1}, teamId:{2}', me, pdUserId, teamId);
    var response = this.rest.deleteREST('teams/' + teamId + '/users/' + pdUserId);
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (status != 204) {
      this._setError(me, 'Failed remove user from team, ' + pdUserId);
      var error_message = this.pd.getUserNameByPDID(pdUserId) + ' could not removed from the ' + this.pd.getTeamNameByPDID(teamId) + ' Team in PagerDuty. This is likely due to the user still being on a corresponding Escalation Policy in PagerDuty. You can remove the user from the team manually in PagerDuty.';
      group.x_pd_integration_pd_error_message = error_message;
      group.update();
    }
  },

  _createTeam: function (group) {
    var me = '_createTeam';
    gs.debug('{0} group:{1}', me, group.getDisplayValue());
    var postBody = {
      team: {
        type: 'team',
        name: this._removeInvalidCharacters(group.getValue('name')),
        description: group.getValue('description') || ''
      }
    };
    var response = this.rest.postREST('teams', postBody, this.userEmail);

    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (status == 402) {
      this._setError(me, 'PD account does not have the "teams" feature');
      return null;
    } else if (status != 201) {
      this._setError(me, 'Failed to create team');
      return null;
    }

    var body = this.JSON.decode(response.getBody());
    var teamId = body.team.id;
    return teamId;
  },

  _addEpToTeam: function (epId, teamId) {
    var me = '_addEpToTeam';
    gs.debug('{0} epId:{1} teamId:{2}', me, epId, teamId);
    var response = this.rest.putREST('teams/' + teamId + '/escalation_policies' + '/' + epId, {}, this.userEmail);
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (status == 402) {
      this._setError(me, 'PD account does not have the "teams" feature');
    } else if (status != 204) {
      this._setError(me, 'Failed to add escalation policy to team');
    }
  },

  _addMappedMembersToTeam: function (group, teamId) {
    var me = '_addMappedMembersToTeam';
    gs.debug('{0} group:{1} teamId:{2}', me, group.getDisplayValue(), teamId);
    var groupMember = new GlideRecordSecure('sys_user_grmember');
    groupMember.addQuery('group', group.sys_id);
    groupMember.query();
    gs.info('{0}, before while', me);
    var user;
    var pdUserId;
    while (groupMember.next()) {
      user = groupMember.user.getRefRecord();
      pdUserId = user.x_pd_integration_pagerduty_id;
      if (gs.nil(pdUserId)) {
        gs.info('{0}, continue: {1}', me, pdUserId);
        continue;
      }
      this.addUserToPdTeam(pdUserId, teamId);
    }
  },

  /**
   * Get country code from provided phone number
   * @param {String} phone number
   * @return {String} country code
   */

  _getCountryCode: function (phoneNumber) {
    var COUNTRY_CODES = [880, 32, 226, 359, 387, 1246, 681, 590, 1441, 673, 591, 973, 257, 229, 975, 1876, 267, 685, 599, 55, 1242, 441534, 375, 501, 7, 250, 381, 670, 262, 993, 992, 40, 690, 245, 1671, 502, 30, 240, 590, 81, 592, 441481, 594, 995, 1473, 44, 241, 503, 224, 220, 299, 350, 233, 968, 216, 962, 385, 509, 36, 852, 504, 58, 1787, 970, 680, 351, 47, 595, 964, 507, 689, 675, 51, 92, 63, 870, 48, 508, 260, 212, 372, 20, 27, 593, 39, 84, 677, 251, 252, 263, 966, 34, 291, 382, 373, 261, 590, 212, 377, 998, 95, 223, 853, 976, 692, 389, 230, 356, 265, 960, 596, 1670, 1664, 222, 441624, 256, 255, 60, 52, 972, 33, 246, 290, 358, 679, 500, 691, 298, 505, 31, 47, 264, 678, 687, 227, 672, 234, 64, 977, 674, 683, 682, 225, 41, 57, 86, 237, 56, 61, 242, 236, 243, 420, 357, 61, 506, 599, 238, 53, 268, 963, 599, 996, 254, 211, 597, 686, 855, 1869, 269, 239, 421, 82, 386, 850, 965, 221, 378, 232, 248, 7, 1345, 65, 46, 249, 1809, 1767, 253, 45, 1284, 49, 967, 213, 598, 262, 961, 1758, 856, 688, 886, 1868, 90, 94, 423, 371, 676, 370, 352, 231, 266, 66, 228, 235, 1649, 218, 379, 1784, 971, 376, 1268, 93, 1264, 1340, 354, 98, 374, 355, 244, 1684, 54, 61, 43, 297, 91, 35818, 994, 353, 62, 380, 974, 258, 1];

    for (var i = 4; i >= 1; i--) {
      var countryCode = phoneNumber.substr(0,i);
      for (var j=0; j < COUNTRY_CODES.length; j++) {
        if (COUNTRY_CODES[j] === parseInt(countryCode))
          return countryCode;
      }
    }
    return null;
  },

  /**
   * Create user contact methods from user phone number
   * @param {String} User PagerDuty ID
   * @param {String} contact type [email_contact_method, phone_contact_method, push_notification_contact_method, sms_contact_method]
   * @param {String} address
   * @return {String} contact method ID
   */
  _createContactMethod: function (userID, type, address, countryCode) {
    var me = '_createContactMethod';
    gs.debug('{0} creating contact method for userID {1}, type:{2}, address:{3}', me, userID, type, address);

    var postBody = {
      contact_method: {
        type: type,
        address: address,
        country_code: countryCode
      }
    };

    //if (!gs.nil(countryCode))
    //	postBody.country_code = countryCode;

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'users/' + userID + '/contact_methods';
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = 'error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      gs.debug('{0} body.contact_method= {1}', me, this.JSON.encode(body.contact_method));
      var contactID = body.contact_method.id;
      var contactType = body.contact_method.type;
      gs.debug('{0} userId = {1}, contactID = {2}, contactType = {3}', me, userID, contactID, contactType);
      return [contactID, contactType];

    } else {
      this._setError(me, 'unknown error, (' + status + ') body:' + response.getBody());
    }
  },

  /**
   * Create notification rules for user phone number
   * @param {String} contact method ID
   * @return void
   */
  _createNotificationRule: function (userID, contactID, contactType) {
    var me = '_createNotificationRule';
    gs.debug('{0} creating notifcation rule for contactID {1}', me, contactID);

    if (gs.nil(contactID)) {
      this._setError(me, 'Missing required contactID');
      return;
    }

    var postBody = {
      notification_rule: {
        type: 'assignment_notification_rule',
        start_delay_in_minutes: 0,
        contact_method: {
          id: contactID,
          type: contactType
        },
        urgency: 'high'
      }
    };

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'users/' + userID + '/notification_rules';
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = 'error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      gs.debug('{0} body.notification_rule= {1}', me, this.JSON.encode(body.notification_rule));
    } else {
      this._setError(me, 'unknown error, (' + status + ') body:' + response.getBody());
    }
  },

  /**
   * Update ServiceNow user record with PagerDuty ID, using import table
   * @param {GlideRecordSecure} user record
   * @param {String} PagerDuty ID for user
   * @return void
   */
  _updateUser: function (user, id) {
    var me = '_updateUser';
    //update user through import set for tracking purposes
    var gr = new GlideRecordSecure('x_pd_integration_pagerduty_user_import');
    gr.setValue('user_sysid', user.getUniqueValue());
    gr.setValue('id', id);
    gr.insert();
    gs.debug('{0} added import for for user {1} with id:{2}', me, user.getDisplayValue(), id);
  },

  /**
   * Creat a new PagerDuty user
   * @param {GlideRecordSecure} user record
   * @param {String} PagerDuty role level ('user|admin')
   * @return void
   */
  _createPDUser: function (user, role) {
    var me = '_createPDUser';
    gs.debug('{0} creating user for {1} with {2} role', me, user.getDisplayValue(), role);
    var postBody = {
      user: {
        type: 'user',
        name: user.getDisplayValue(),
        email: user.getValue('email'),
        role: role
      }
    };

    var title = user.getValue('title');
    if (!gs.nil(title))
      postBody.job_title = title;

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'users';
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = 'error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      gs.debug('{0} body.user = {1}', me, this.JSON.encode(body.user));
      var userId = body.user.id;
      gs.debug('{0} userId = {1}', me, userId);

      this._updateUser(user, userId);
      return userId;

    } else {
      this._setError(me, 'unknown error, (' + status + ') body:' + response.getBody());
    }

  },

  _getCurrentOrDefaultUserPdId: function () {
    var me = '_getCurrentOrDefaultUserPdId';
    var user = new GlideRecordSecure('sys_user');
    user.get(gs.getUserID());
    var userPdID = user.getValue('x_pd_integration_pagerduty_id');
    gs.debug('{0} found userPdID {1} in user record', me, userPdID);

    if (gs.nil(userPdID)) {
      if (this.autoProvisionUsers == 'true') {
        gs.debug('{0} auto-provisioning enabled, creating PagerDuty user for ID:{1}', me, userPdID);
        gs.info(
          "{0} current user '{1}' does not have a PagerDuty ID, auto-provisioning enabled, attempting to create it",
          me, userPdID);

        userPdID = this.provisionUser(user);
        gs.debug('{0} provisioned new user {1}:{2}', me, user.getDisplayValue(), userPdID);
      } else {
        //attempt to use default user from property
        var defaultUserID = gs.getProperty('x_pd_integration.default_user');
        if (gs.nil(defaultUserID)) {
          gs.error('{0} attempting to use default user property but it is empty, aborting group provisioning', me);
          return;
        } else {
          userPdID = defaultUserID;
        }
      }
    }

    return userPdID;
  },

  /**
   * Provision a group service and esclation policy
   * @param {GlideRecordSecure} sys_user_group record
   * @param {String} userPdID - optional - user pager duty ID
   * @return {Object} - object with updated pd ids;
   */
  provisionGroupService: function (group, userPdID, taskType) {
    var me = 'provisionGroupService';
    gs.debug('{0} group:{1}, userPdID:{2}', me, group.getDisplayValue(), userPdID);

    var groupMembersRecord;
    if (this.autoProvisionGrmembers == 'true') {
      groupMembersRecord = this._getGroupMembersRecord(group);
      if (!groupMembersRecord.hasNext()) {
        return gs.addErrorMessage('Flag auto provision group members enabled but group not exists members. Provisioning aborting...');
      }
    }

    if (!userPdID) {
      userPdID = this._getCurrentOrDefaultUserPdId();
    }

    if (!gs.nil(group.x_pd_integration_pagerduty_service)) {
      gs.error('{0} group {1} already has a service ID, aborting provisioning', me, group.getDisplayValue());
      return;
    }

    var scheduleID;
    if (this.autoCreateSchedule == 'true') {
      scheduleID = this.createSchedule(group);
    }

    var grmembersPdIDs;
    var policyID;
    if (groupMembersRecord) {
      gs.debug('{0} group {1} try provisioning members', me, group.getDisplayValue());
      grmembersPdIDs = this.provisionGroupMembers(groupMembersRecord);
      policyID = this._createPolicy(group, grmembersPdIDs, scheduleID && [scheduleID]);
    } else {
      policyID = this._createPolicy(group, [userPdID], scheduleID && [scheduleID]);
    }

    if (!policyID) {
      gs.error('{0} failed to create escalation policy, cannot create group service', me);
      return;
    }

    var teamID;
    if (this.autoCreationPdTeams == 'true') {
      teamID = this.createPdTeam(group, policyID);
    }

    var serviceID;
    var webhookID;
    if (this.sn2pdMapping == 'Assignment Groups map to PagerDuty') {
      serviceID = this._createGroupService(group, policyID);
      if (!serviceID) {
        gs.error('{0}: failed to create service', me);
        return;
      }

      webhookID = this.createServiceWebhook('ServiceNow', serviceID, taskType);
      gs.addInfoMessage("Submitted group to PagerDuty. Service and escalation policy will be created. You will be the initial contact for the escalation policy.");
    } else {
      gs.addInfoMessage("Submitted group to PagerDuty. Escalation policy only will be created. You will be the initial contact for the escalation policy.");
    }

    return this.updateGroupPdIds(group, {
      escalation_id: policyID,
      schedule_id: scheduleID,
      service_id: serviceID,
      webhook_id: webhookID,
      team_id: teamID
    });
  },

  /**
   * Provision a CI service and esclation policy
   * @param {GlideRecordSecure} cmdb_ci record
   * @return void
   */
  provisionCIService: function (ci, userPdID, taskType) {
    var me = 'provisionCIService';
    gs.debug('{0} ci:{1}, userPdID:{2}', me, ci.getDisplayValue(), userPdID);

    if (!userPdID) {
      userPdID = this._getCurrentOrDefaultUserPdId();
    }

    if (!gs.nil(ci.x_pd_integration_pagerduty_service)) {
      gs.error('{0} group {1} already has a service ID, aborting provisioning', me, group.getDisplayValue());
      return;
    }

    var policyID;
    if (!gs.nil(ci.assignment_group)) {
      var group = ci.assignment_group.getRefRecord();
      if (!gs.nil(group.sys_id)) {
        if (gs.nil(group.x_pd_integration_pagerduty_escalation)) {
          policyID = this.provisionGroupService(group, userPdID).escalation_id;
        } else {
          policyID = group.x_pd_integration_pagerduty_escalation.toString();
        }
      } else {
        gs.error('{0} group not exist', me);
        return;
      }
    } else {
      policyID = this._createPolicy(ci, [userPdID]);
    }

    if (gs.nil(policyID)) {
      gs.error('{0} failed to create escalation policy, cannot create ci service', me);
      return;
    }

    var serviceID = this._createGroupService(ci, policyID);
    if (gs.nil(serviceID)) {
      gs.error('{0}: failed to create service', me);
      return;
    }

    var webhookID = this.createServiceWebhook('ServiceNow', serviceID, taskType);

    this._updateCISync(ci, serviceID, webhookID);
  },

  _updateCISync: function (ci, serviceID, webhookID) {
    var me = '_updateCISync';
    ci.setValue('x_pd_integration_pagerduty_service', serviceID);
    ci.setValue('x_pd_integration_pagerduty_webhook', webhookID);
    ci.update();
  },

/**
   * Provision a CI business service
   * @param {GlideRecordSecure} cmdb_ci record
   * @return void
   */
  provisionCIBusinessService: function (ci) {
    var me = 'provisionCIBusinessService';
    gs.debug('{0} ci:{1}', me, ci.getDisplayValue());

    if (!gs.nil(ci.x_pd_integration_pagerduty_business_service)) {
      gs.error('{0} CI {1} already has a business service ID, aborting provisioning', me, ci.getDisplayValue());
      return;
    }

    var serviceID = this._createBusinessService(ci);
    if (gs.nil(serviceID)) {
      gs.error('{0}: failed to create service', me);
      return;
    }
	ci.x_pd_integration_pagerduty_business_service = serviceID;
	ci.update();
    // this._updateCI(ci, serviceID, webhookID);
  },

	createDependency: function(parent_ci, child_ci, rel_type) {
		var me = 'createDependency';
		var parent_pd_id = parent_ci.getValue("x_pd_integration_pagerduty_business_service") || parent_ci.getValue("x_pd_integration_pagerduty_service");
		var child_pd_id = child_ci.getValue("x_pd_integration_pagerduty_business_service") || child_ci.getValue("x_pd_integration_pagerduty_service");
		var parent_type = parent_ci.getValue("service_classification") == "Business Service" ? "business_service" : "service";
		var child_type = child_ci.getValue("service_classification") == "Business Service" ? "business_service" : "service";

		if ( gs.nil(parent_pd_id) ) {
			return me + " no PD ID on parent CI " + parent_ci.getValue("name");
		}
		
		if ( gs.nil(child_pd_id) ) {
			return me + " no PD ID on child CI " + child_ci.getValue("name");
		}

		var rest = new x_pd_integration.PagerDuty_REST();
		var feature = 'service_dependencies/associate';
		var postBody = {
            "relationships": [
            {
                "dependent_service":
                {
                    "id": parent_pd_id,
                    "type": parent_type
                },
                "relationship_type": rel_type,
                "supporting_service":
                {
                    "id": child_pd_id,
                    "type": child_type
                }
            }]
        };
        var pd = new x_pd_integration.PagerDuty();
        var userEmail = pd.getValidEmail(gs.getUserID());
        var response = rest.postREST(feature, postBody, userEmail);
        var body = this.JSON.decode(response.getBody());
        var status = response.getStatusCode();
        gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

        if (response.haveError()) {
            var errCode = body.error.code;
            var errors = body.error.errors.toString();
            var errorMessage = me + ' error: ' + body.error.message;

            this._setError(me, errCode + ':' + errorMessage + ':' + errors);
            return errorMessage;
        }

        if (status >= 200 && status < 300) {
            return me + " successfully sent dependency to PD, request body: " + JSON.stringify(postBody);
        } else {
            gs.error('Error in {0}: {1}', me, response.getErrorMessage());
			return 'Error ' + status + ' in ' + me + ': ' + response.getBody();
        }
	},

/**
   * Create a PagerDuty service for a group
   * @param {GlideRecordSecure} sys_user_group record
   * @param {String} esclation policy ID
   * @return {String} new service ID
   */
  _createBusinessService: function (ci) {
    var me = '_createBusinessService';
    gs.debug('{0}: service name {1}', me, this._removeInvalidCharacters(ci.getDisplayValue()));
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'business_services';
    var postBody = {
      'business_service': {
        'name': 'SN:' + this._removeInvalidCharacters(ci.getDisplayValue()),
      }
    };

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = 'error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      var id = body.business_service.id;
      gs.debug('{0} id = {1}', me, id);
      return id;
    } else {
      gs.error('Error in {0}: {1}', me, response.getErrorMessage());
    }
  },

  /**
   * Add webhook for service
   * @param {String} serviceID
   * @return webhookID
   */
  createServiceWebhook: function (name, serviceID, taskType) {
    var me = 'createServiceWebhook';
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'webhooks';
    var baseURL = gs.getProperty('glide.servlet.uri');
    var instanceName = gs.getProperty('instance_name');
    taskType = taskType || 'incident';

    //Ent v3.1 migrate from processor to REST API
    var webhookRestApi = gs.getProperty('x_pd_integration.webhook_restapi');

    var webhookUrl = baseURL + webhookRestApi;

    var postBody = {
      'webhook': {
        'description': 'Auto provisioned via ServiceNow Integration. This extension sends data back to your ServiceNow instance.',
        'name': 'ServiceNow (' + instanceName + ')',
        'summary': 'ServiceNow (' + instanceName + ')',
        'type': 'webhook',
        'outbound_integration': {
          'id': 'PBZUP2B',
          'type': 'outbound_integration'
        },
        'config': {
          'target': webhookUrl,
          'sync_options': 'sync_all',
          'snow_user': this.snAuthUser,
          'snow_password': this.snAuthUserPwd,
          'task_type': taskType,
        },
        'webhook_object': {
          'id': serviceID,
          'type': 'service'
        }
      }
    };
    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();

    gs.debug('{0} response: {0}:{1}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = ' error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      var id = body.webhook.id;
      gs.debug("{0} created webhook '{1}' for service:{2}", me, webhookUrl, serviceID);
      return id;
    } else {
      this._setError(me, 'unknown error, body:' + response.getBody());
    }
  },

  /**
   * Update ServiceNow group record with PagerDuty ids from props object
   * @param {GlideRecordSecure} group record
   * @param {Object} props - object with keys & values for update ServiceNow group record
   * @return {Object} - object with only saved ids;
   */
  updateGroupPdIds: function (group, props) {
    var me = '_updateGroupPdIds';
    gs.debug('{0} try to update pd ids for group:{1}', me, group.getDisplayValue());
    var gr = new GlideRecordSecure('x_pd_integration_pagerduty_group_import');
    gr.setValue('group_sysid', group.getUniqueValue());

    Object.keys(props).forEach(function (key) {
      if (props[key]) {
        gr.setValue(key, props[key]);
      } else {
        delete props[key];
      }
    });

    gr.insert();
    gs.debug('{0} added import for for group {1} with {2}', me, group.getDisplayValue(), this.JSON.encode(props));
    return props;
  },

  /**
   * @deprecated since version 5.0, left for backward compatibility
   * Update ServiceNow group record with PagerDuty service, policy ID and webhook ID, using import table
   * @param {GlideRecordSecure} group record
   * @param {String} PagerDuty service ID
   * @param (String) PagerDuty escalation policy ID
   * @param (String) PagerDuty webhook ID
   * @return void
   */
  _updateGroup: function (group, serviceID, escalationID, webhookID, scheduleID) {
    var me = '_updateGroup';
    //update user through import set for tracking purposes
    var gr = new GlideRecordSecure('x_pd_integration_pagerduty_group_import');
    gr.setValue('group_sysid', group.getUniqueValue());
    gr.setValue('escalation_id', escalationID);
    gr.setValue('service_id', serviceID);
    gr.setValue('webhook_id', webhookID);
    if (scheduleID) {
      gr.setValue('schedule_id', scheduleID);
    }
    gr.insert();
    gs.debug('{0} added import for for group {1} with service:{2}, policy:{3}, schedule:{4} and webhook:{5}', me, group.getDisplayValue(),
      serviceID,
      escalationID,
      scheduleID,
      webhookID);
  },

  /**
   * @deprecated since version 5.0, left for backward compatibility
   * Update ServiceNow group record with PagerDuty policy ID using import table
   * @param {GlideRecordSecure} group record
   * @param (String) PagerDuty escalation policy ID
   * @return void
   */
  _updateGroupEP: function (group, escalationID) {
    var me = '_updateGroupEP';
    //update group through import set for tracking purposes
    var gr = new GlideRecordSecure('x_pd_integration_pagerduty_group_import');
    gr.setValue('group_sysid', group.getUniqueValue());
    gr.setValue('escalation_id', escalationID);
    gr.insert();
    gs.debug('{0} added import for for group {1} with policy:{2}', me, group.getDisplayValue(), escalationID);
  },

  /**
   * Update ServiceNow ci record with PagerDuty service, policy ID and webhook ID, using import table
   * @param {GlideRecordSecure} ci record
   * @param {String} PagerDuty service ID
   * @param (String) PagerDuty webhook ID
   * @return void
   */
  _updateCI: function (ci, serviceID, webhookID) {
    var me = '_updateCI';
    //update CI through import set for tracking purposes
    var gr = new GlideRecordSecure('x_pd_integration_pagerduty_ci_import');
    gr.setValue('cmdb_ci_sysid', ci.getUniqueValue());
    gr.setValue('service_id', serviceID);
    gr.setValue('webhook_id', webhookID);
    gr.insert();
    gs.debug('{0} added import for ci {1} with service:{2} and webhook:{3}', me, ci.getDisplayValue(), serviceID, webhookID);
  },

  addScheduleToEscalationPolicy: function (escalationID, scheduleID) {
    var me = 'addScheduleToEscalationPolicy';
    gs.debug('{0} escalationID:{1} scheduleID:{2}', me, escalationID, scheduleID);
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'escalation_policies/' + escalationID;
    var putBody = {
      "escalation_policy": {
        "escalation_rules": [
          {
            "escalation_delay_in_minutes": 1,
            "targets": [
              {
                "id": scheduleID,
                "type": "schedule_reference"
              }
            ]
          }
        ]
      }
    };
    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.putREST(feature, putBody, userEmail);
    var status = response.getStatusCode();
    gs.debug("_createSchedule response: {0}:{1}", status, response.getBody());

    if (status != 200 || status != 201) {
      gs.error("Error in _createSchedule: " + response.getErrorMessage());
    }
  },

  /**
   * Create a PagerDuty service for a group
   * @param {GlideRecordSecure} sys_user_group record
   * @param {String} esclation policy ID
   * @return {String} new service ID
   */
  _createGroupService: function (group, policyID) {
    var me = '_createGroupService';
    gs.debug('{0}: service name {1}', me, this._removeInvalidCharacters(group.getDisplayValue()));
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'services';
    var postBody = {
      'service': {
        'type': 'service',
        'name': 'SN:' + this._removeInvalidCharacters(group.getDisplayValue()),
        'status': 'active',
        'escalation_policy': {
          'id': policyID,
          'type': 'escalation_policy_reference'
        },
        'alert_creation': 'create_alerts_and_incidents'
      }
    };



    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.postREST(feature, postBody, userEmail);
    var body = this.JSON.decode(response.getBody());
    var status = response.getStatusCode();
    gs.debug('{0} response: {1}:{2}', me, status, response.getBody());

    if (response.haveError()) {
      var errCode = body.error.code;
      var errors = body.error.errors.toString();
      var errorMessage = 'error: ' + body.error.message;

      this._setError(me, errCode + ':' + errorMessage + ':' + errors);
      return;
    }

    if (status == 200 || status == 201) {
      var id = body.service.id;
      gs.debug('{0} id = {1}', me, id);
      return id;
    } else {
      gs.error('Error in createPolicy: ' + response.getErrorMessage());
    }
  },


  /**
   * Create a PagerDuty escalation policy for a group
   * @param {GlideRecordSecure} sys_user_group record
   * @param {Array} pdUserIds users PagerDuty IDs, used as policy target
   * @return {String} new policy ID
   */
  _createPolicy: function (group, pdUserIds, pdScheduleIds) {
    var me = '_createPolicy';
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'escalation_policies';

    var userTargets = pdUserIds.map(function (pdUserId) {
      return {
        'id': pdUserId,
        'type': 'user_reference'
      };
    });

    var scheduleTargets = [];
    if (pdScheduleIds) {
      scheduleTargets = pdScheduleIds.map(function (scheduleId) {
        return {
          'id': scheduleId,
          'type': 'schedule_reference'
        };
      });
    }

    var targets = scheduleTargets.concat(userTargets);

    gs.debug('targets: {0}', targets);

    var postBody = {
      'escalation_policy': {
        'type': 'escalation_policy',
        'name': 'SN:' + this._removeInvalidCharacters(group.getDisplayValue()),
        'escalation_rules': [
          {
            'escalation_delay_in_minutes': 30,
            'targets': targets
          }
        ]
      }
    };

    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.postREST(feature, postBody, userEmail);
    var status = response.getStatusCode();
    gs.debug('createPolicy response: {0}:{1}', status, response.getBody());

    if (status == 200 || status == 201) {
      var body = this.JSON.decode(response.getBody());
      var id = body.escalation_policy.id;
      gs.debug('createPolicy.id = {0}', id);

      return id;

    } else {
      gs.addErrorMessage('Error in createPolicy: ' + response.getErrorMessage());
    }
  },

  //TODO: write doc
  /**
   */
  createSchedule: function (group) {
    var me = "_createSchedule";
    gs.debug('{0} group:{1}', me, group.getDisplayValue());
    var rest = new x_pd_integration.PagerDuty_REST();
    var feature = 'schedules';
    var currentDate = new Date();
    var inOneMonth = new Date();
    var numberOfDaysToAdd = 30;
    inOneMonth = new Date(inOneMonth.setDate(inOneMonth.getDate() + numberOfDaysToAdd));
    var zoneName = "America/Los_Angeles";
    var groupManager = group.manager;
    var pdUserID;
    if (gs.nil(groupManager)) {
      var user = new GlideRecordSecure('sys_user');
      user.get(gs.getUserID());
      pdUserID = this.provisionUser(user);
    } else {
      pdUserID = this.provisionUser(groupManager.getRefRecord());
    }
    var postBody = {
      "schedule": {
        "type": feature,
        "time_zone": zoneName,
        "name": "SN-" + this._removeInvalidCharacters(group.getDisplayValue()),
        "description": "Schedule was created by ServiceNow",
        "schedule_layers": [
          {
            "name": 'ServiceNow default schedule layer',
            "start": currentDate.toISOString(),
            "end": inOneMonth.toISOString(),
            "rotation_virtual_start": currentDate.toISOString(),
            "rotation_turn_length_seconds": 86400,
            "users": [
              {
                "id": pdUserID,
                "type": "user"
              }
            ]
          }
        ]
      }
    };
    var pd = new x_pd_integration.PagerDuty();
    var userEmail = pd.getValidEmail(gs.getUserID());
    var response = rest.postREST(feature, postBody, userEmail);
    var status = response.getStatusCode();
    gs.debug("_createSchedule response: {0}:{1}", status, response.getBody());

    if (status == 200 || status == 201) {
      var body = this.JSON.decode(response.getBody());
      var id = body.schedule.id;
      gs.debug("schedule.id = {0}", id);

      return id;

    } else {
      gs.error("Error in _createSchedule: " + response.getErrorMessage());
    }
  },

  /**
   * Track error
   * @param {String} method reporting error
   * @param {String} error message
   * @return void
   */
  _setError: function (method, msg) {
    this.errorMsg = method + ' error: ' + msg;
    this.hasError = true;
    gs.error('{0} error: {1}', method, msg);
  },

  /**
   * Does class have an error
   * @return {Boolean} has error
   */
  hasError: function () {
    return this.hasError;
  },

  /**
   * Get last error message
   * @return {String} error message
   */
  getError: function () {
    if (!gs.nil(this.errorMsg))
      return this.errorMsg;
  },

  _removeInvalidCharacters: function (name) {
    return name.replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, '');
  },

  type: 'PagerDutyProvisioning'
};

