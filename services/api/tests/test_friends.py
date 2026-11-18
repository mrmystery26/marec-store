import re
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.db import utcnow
from app.modules.auth.models import User
from app.modules.friends import service
from app.modules.friends.models import Friendship
from tests.helpers import PASSWORD, bearer, code, login, register

CODE_SHAPE = re.compile(r"^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$")


class Player:
    def __init__(self, user, headers, friend_code):
        self.user = user
        self.id = user.id
        self.headers = headers
        self.code = friend_code


def make_player(client, db_session, name):
    email = f"{name.lower()}@example.com"
    assert register(client, email=email, password=PASSWORD, name=name).status_code == 201
    user = db_session.scalar(select(User).where(User.email == email))
    headers = bearer(login(client, email=email, password=PASSWORD).json())
    friend_code = client.get("/v1/friends/code", headers=headers).json()["code"]
    return Player(user, headers, friend_code)


@pytest.fixture()
def ana(client, db_session):
    return make_player(client, db_session, "Ana")


@pytest.fixture()
def bea(client, db_session):
    return make_player(client, db_session, "Bea")


@pytest.fixture()
def cy(client, db_session):
    return make_player(client, db_session, "Cy")


def send(client, sender, target_code):
    return client.post(
        "/v1/friends/requests", json={"friend_code": target_code}, headers=sender.headers
    )


def make_friends(client, first, second):
    sent = send(client, first, second.code)
    assert sent.status_code == 201, sent.text
    accepted = client.post(
        f"/v1/friends/requests/{sent.json()['id']}/accept", headers=second.headers
    )
    assert accepted.status_code == 200, accepted.text


def friends_of(client, player):
    return client.get("/v1/friends", headers=player.headers).json()


def requests_of(client, player):
    return client.get("/v1/friends/requests", headers=player.headers).json()


# ------------------------------------------------------------------ access
def test_every_friends_endpoint_needs_a_login(client):
    someone = str(uuid.uuid4())
    calls = [
        ("get", "/v1/friends"),
        ("get", "/v1/friends/requests"),
        ("post", "/v1/friends/requests"),
        ("post", f"/v1/friends/requests/{someone}/accept"),
        ("post", f"/v1/friends/requests/{someone}/decline"),
        ("delete", f"/v1/friends/requests/{someone}"),
        ("get", "/v1/friends/code"),
        ("post", "/v1/friends/code/reset"),
        ("delete", f"/v1/friends/{someone}"),
    ]
    for method, path in calls:
        response = getattr(client, method)(path)
        assert response.status_code == 401, (method, path)


# ------------------------------------------------------------------ friend codes
def test_a_code_is_made_once_and_is_easy_to_read(client, ana, bea):
    assert CODE_SHAPE.match(ana.code)
    again = client.get("/v1/friends/code", headers=ana.headers).json()["code"]
    assert again == ana.code
    assert ana.code != bea.code


def test_resetting_gives_a_new_code_and_the_old_one_stops_working(client, ana, bea):
    reset = client.post("/v1/friends/code/reset", headers=ana.headers)
    assert reset.status_code == 200
    new_code = reset.json()["code"]
    assert CODE_SHAPE.match(new_code) and new_code != ana.code
    assert client.get("/v1/friends/code", headers=ana.headers).json()["code"] == new_code

    assert code(send(client, bea, ana.code)) == "FRIEND_CODE_NOT_FOUND"
    assert send(client, bea, new_code).status_code == 201


def test_a_code_can_be_typed_loosely(client, ana, bea):
    loose = " " + ana.code.lower().replace("-", " ") + " "
    response = send(client, bea, loose)
    assert response.status_code == 201
    assert response.json()["display_name"] == "Ana"


def test_wrong_codes_are_explained(client, ana):
    assert code(send(client, ana, "hello")) == "INVALID_FRIEND_CODE"
    assert code(send(client, ana, "ABCD-IOIO")) == "INVALID_FRIEND_CODE"  # letters not in codes
    assert code(send(client, ana, "")) == "INVALID_FRIEND_CODE"
    assert code(send(client, ana, "ABCD-2345-6789")) == "INVALID_FRIEND_CODE"
    assert send(client, ana, "A" * 200).status_code == 422  # absurdly long input is refused early
    unknown = "ABCD-2345" if ana.code != "ABCD-2345" else "ABCD-2346"
    assert code(send(client, ana, unknown)) == "FRIEND_CODE_NOT_FOUND"


def test_you_cannot_add_yourself(client, ana):
    response = send(client, ana, ana.code)
    assert response.status_code == 400
    assert code(response) == "CANNOT_ADD_SELF"


# ------------------------------------------------------------------ requests
def test_a_request_is_seen_by_both_and_accepting_makes_friends(client, ana, bea):
    sent = send(client, ana, bea.code)
    assert sent.status_code == 201
    assert sent.json()["status"] == "pending"
    assert sent.json()["display_name"] == "Bea"

    ana_requests = requests_of(client, ana)
    assert [r["display_name"] for r in ana_requests["outgoing"]] == ["Bea"]
    assert ana_requests["incoming"] == []
    bea_requests = requests_of(client, bea)
    assert [r["display_name"] for r in bea_requests["incoming"]] == ["Ana"]
    assert bea_requests["incoming"][0]["user_id"] == str(ana.id)
    assert bea_requests["outgoing"] == []
    assert friends_of(client, ana)["total"] == 0

    request_id = bea_requests["incoming"][0]["id"]
    accepted = client.post(f"/v1/friends/requests/{request_id}/accept", headers=bea.headers)
    assert accepted.status_code == 200
    assert accepted.json()["display_name"] == "Ana"

    for player, other in ((ana, bea), (bea, ana)):
        listing = friends_of(client, player)
        assert listing["total"] == 1
        assert listing["items"][0]["user_id"] == str(other.id)
        assert listing["items"][0]["since"]
        assert requests_of(client, player) == {"incoming": [], "outgoing": []}


def test_you_cannot_send_twice_or_ask_a_friend(client, ana, bea):
    assert send(client, ana, bea.code).status_code == 201
    again = send(client, ana, bea.code)
    assert again.status_code == 409 and code(again) == "REQUEST_ALREADY_SENT"

    request_id = requests_of(client, bea)["incoming"][0]["id"]
    client.post(f"/v1/friends/requests/{request_id}/accept", headers=bea.headers)
    for sender, target in ((ana, bea), (bea, ana)):
        response = send(client, sender, target.code)
        assert response.status_code == 409 and code(response) == "ALREADY_FRIENDS"


def test_two_requests_that_meet_make_friends_at_once(client, ana, bea):
    assert send(client, ana, bea.code).status_code == 201
    met = send(client, bea, ana.code)
    assert met.status_code == 200
    assert met.json()["status"] == "accepted"
    assert friends_of(client, ana)["total"] == 1 and friends_of(client, bea)["total"] == 1
    assert requests_of(client, ana) == {"incoming": [], "outgoing": []}


def test_declining_stops_the_sender_but_the_decliner_can_ask_instead(client, ana, bea):
    send(client, ana, bea.code)
    request_id = requests_of(client, bea)["incoming"][0]["id"]
    declined = client.post(f"/v1/friends/requests/{request_id}/decline", headers=bea.headers)
    assert declined.status_code == 204
    assert requests_of(client, ana) == {"incoming": [], "outgoing": []}
    assert requests_of(client, bea) == {"incoming": [], "outgoing": []}
    assert friends_of(client, ana)["total"] == 0

    retry = send(client, ana, bea.code)  # the person who was declined cannot keep asking
    assert retry.status_code == 409 and code(retry) == "REQUEST_DECLINED"

    fresh = send(client, bea, ana.code)  # but the one who declined can ask them
    assert fresh.status_code == 201 and fresh.json()["status"] == "pending"
    assert [r["display_name"] for r in requests_of(client, ana)["incoming"]] == ["Bea"]
    new_id = requests_of(client, ana)["incoming"][0]["id"]
    accepted = client.post(f"/v1/friends/requests/{new_id}/accept", headers=ana.headers)
    assert accepted.status_code == 200
    assert friends_of(client, bea)["total"] == 1


def test_the_sender_can_take_a_request_back(client, ana, bea):
    send(client, ana, bea.code)
    request_id = requests_of(client, ana)["outgoing"][0]["id"]

    path = f"/v1/friends/requests/{request_id}"
    assert client.delete(path, headers=bea.headers).status_code == 404  # not the sender
    assert client.delete(path, headers=ana.headers).status_code == 204
    assert requests_of(client, bea)["incoming"] == []
    assert send(client, ana, bea.code).status_code == 201  # and may ask again later


def test_only_the_receiver_can_accept_or_decline(client, ana, bea, cy):
    send(client, ana, bea.code)
    request_id = requests_of(client, bea)["incoming"][0]["id"]
    base = f"/v1/friends/requests/{request_id}"
    accept, decline = f"{base}/accept", f"{base}/decline"

    for who in (ana, cy):  # the sender and an outsider both look like "no such request"
        assert client.post(accept, headers=who.headers).status_code == 404
        assert client.post(decline, headers=who.headers).status_code == 404
    unknown = f"/v1/friends/requests/{uuid.uuid4()}/accept"
    assert client.post(unknown, headers=bea.headers).status_code == 404
    assert friends_of(client, bea)["total"] == 0


def test_other_players_see_none_of_it(client, ana, bea, cy):
    send(client, ana, bea.code)
    assert requests_of(client, cy) == {"incoming": [], "outgoing": []}
    assert friends_of(client, cy)["total"] == 0


# ------------------------------------------------------------------ unfriending
def test_either_player_can_unfriend_and_ask_again_later(client, ana, bea):
    make_friends(client, ana, bea)
    assert client.delete(f"/v1/friends/{bea.id}", headers=ana.headers).status_code == 204
    assert friends_of(client, ana)["total"] == 0 and friends_of(client, bea)["total"] == 0

    again = client.delete(f"/v1/friends/{bea.id}", headers=ana.headers)
    assert again.status_code == 404 and code(again) == "NOT_FRIENDS"

    make_friends(client, bea, ana)
    assert client.delete(f"/v1/friends/{bea.id}", headers=bea.headers).status_code == 404  # self
    assert client.delete(f"/v1/friends/{ana.id}", headers=bea.headers).status_code == 204


def test_you_cannot_unfriend_someone_who_is_not_your_friend(client, ana, bea, cy):
    make_friends(client, ana, bea)
    assert client.delete(f"/v1/friends/{bea.id}", headers=cy.headers).status_code == 404
    assert friends_of(client, ana)["total"] == 1


# ------------------------------------------------------------------ privacy and accounts
def test_the_friends_list_is_sorted_by_name(client, db_session):
    me = make_player(client, db_session, "Me")
    for name in ("Zed", "amy", "Bob"):
        make_friends(client, me, make_player(client, db_session, name))
    names = [f["display_name"] for f in friends_of(client, me)["items"]]
    assert names == ["amy", "Bob", "Zed"]


def test_no_response_shows_an_email_address(client, ana, bea):
    send(client, ana, bea.code)
    seen = [
        client.get("/v1/friends/requests", headers=bea.headers).text,
        client.get("/v1/friends/requests", headers=ana.headers).text,
        client.get("/v1/friends/code", headers=ana.headers).text,
    ]
    request_id = requests_of(client, bea)["incoming"][0]["id"]
    seen.append(
        client.post(f"/v1/friends/requests/{request_id}/accept", headers=bea.headers).text
    )
    seen.append(client.get("/v1/friends", headers=ana.headers).text)
    assert all("@example.com" not in text for text in seen)


def test_suspended_players_cannot_be_found_or_listed(client, db_session, ana, bea, cy):
    make_friends(client, ana, bea)
    send(client, cy, ana.code)
    for player in (bea, cy):
        row = db_session.get(User, player.id)
        row.status = "suspended"
    db_session.commit()

    assert friends_of(client, ana)["total"] == 0
    assert requests_of(client, ana)["incoming"] == []
    other = make_player(client, db_session, "Dee")
    assert code(send(client, other, bea.code)) == "FRIEND_CODE_NOT_FOUND"


# ------------------------------------------------------------------ limits
def test_there_is_a_limit_on_waiting_requests(client, db_session, monkeypatch, ana, bea, cy):
    monkeypatch.setattr(service, "MAX_PENDING_OUTGOING", 2)
    dee = make_player(client, db_session, "Dee")
    assert send(client, ana, bea.code).status_code == 201
    assert send(client, ana, cy.code).status_code == 201
    blocked = send(client, ana, dee.code)
    assert blocked.status_code == 409 and code(blocked) == "FRIEND_REQUEST_LIMIT"

    request_id = requests_of(client, ana)["outgoing"][0]["id"]
    client.delete(f"/v1/friends/requests/{request_id}", headers=ana.headers)
    assert send(client, ana, dee.code).status_code == 201


def test_there_is_a_limit_on_friends(client, monkeypatch, ana, bea, cy):
    monkeypatch.setattr(service, "MAX_FRIENDS", 1)
    make_friends(client, ana, bea)
    send(client, cy, ana.code)
    request_id = requests_of(client, ana)["incoming"][0]["id"]
    full = client.post(f"/v1/friends/requests/{request_id}/accept", headers=ana.headers)
    assert full.status_code == 409 and code(full) == "FRIEND_LIMIT_REACHED"
    assert friends_of(client, ana)["total"] == 1


# ------------------------------------------------------------------ stored shape
def test_a_pair_is_stored_once_in_sorted_order(client, db_session, ana, bea):
    send(client, ana, bea.code)
    send(client, bea, ana.code)  # meets the first request
    rows = db_session.scalars(select(Friendship)).all()
    assert len(rows) == 1
    assert rows[0].user_low_id.int < rows[0].user_high_id.int
    assert rows[0].status == "accepted"


def test_the_database_itself_refuses_bad_friendship_rows(db_session, ana, bea):
    low, high = sorted([ana.id, bea.id], key=lambda value: value.int)

    def row(**changes):
        fields = {"user_low_id": low, "user_high_id": high, "requested_by": low}
        return Friendship(id=uuid.uuid4(), **{**fields, **changes})

    bad_rows = [
        row(user_low_id=high, user_high_id=low),  # pair not in order
        row(requested_by=uuid.uuid4()),  # asked by someone outside the pair
        row(status="blocked"),  # unknown status
        row(status="accepted"),  # answered but no answer time
        row(status="pending", responded_at=utcnow()),  # waiting but has an answer time
    ]
    for bad in bad_rows:
        db_session.add(bad)
        with pytest.raises(IntegrityError):
            db_session.commit()
        db_session.rollback()

    db_session.add(row())
    db_session.commit()
    db_session.add(row())  # the same pair twice
    with pytest.raises(IntegrityError):
        db_session.commit()
